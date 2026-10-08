/**
 * The parent model's tools: agent_spawn, agent_send, agent_wait,
 * agent_status, agent_stop, and agent_close.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentService } from "../agents/service.js";
import {
  AgentError,
  type AgentInfo,
  THINKING_LEVELS,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import {
  AGENT_ICON,
  type Colorize,
  formatAgentLine,
  oneLine,
} from "../ui/format.js";
import type { SessionHost } from "./session.js";
import { resolveSpawn } from "./spawn.js";

/** Characters of one agent's result passed to the parent model. */
const MAX_RESULT_CHARS = 40_000;
const PROGRESS_MS = 1_000;

export interface AgentToolDetails {
  at: number;
  agents: AgentInfo[];
  timedOut?: string[];
  message?: string;
}

function text(content: string, details: AgentToolDetails) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function truncateResult(body: string): string {
  if (body.length <= MAX_RESULT_CHARS) return body;
  return `${body.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated: ${body.length - MAX_RESULT_CHARS} more characters. Attach to the agent to read all of it.]`;
}

/** The model-facing summary of one agent: its state and result. */
export function describeAgent(info: AgentInfo): string {
  const head = `## ${info.name} (${info.state})`;
  const result = info.result;
  if (info.state === "working") return head;
  if (info.state === "failed")
    return `${head}\nError: ${result?.errorMessage ?? (result?.text || "unknown")}`;
  if (info.state === "stopped")
    return result?.text ? `${head}\n${truncateResult(result.text)}` : head;
  return `${head}\n${truncateResult(result?.text || "(empty)")}`;
}

function statusLine(info: AgentInfo): string {
  const state = info.activity.tool
    ? `${info.state}, using ${info.activity.tool}`
    : info.state;
  return `${info.name} (${state}): ${oneLine(info.task, 120)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Execute<T extends TSchema> = (
  service: AgentService,
  params: Static<T>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
) => Promise<{ content: string; details: AgentToolDetails }>;

interface AgentToolSpec<T extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  call: (args: Static<T>, color: Colorize) => string;
  execute: Execute<T>;
}

function renderDetails(
  details: AgentToolDetails | undefined,
  expanded: boolean,
  color: Colorize,
): string {
  if (!details) return "";
  const lines: string[] = [];
  if (details.message) lines.push(color("dim", details.message));
  for (const info of details.agents) {
    lines.push(formatAgentLine(info, details.at, color));
    if (expanded && info.state !== "working" && info.result?.text)
      lines.push(...info.result.text.split("\n").map((line) => `  ${line}`));
  }
  if (details.timedOut && details.timedOut.length > 0)
    lines.push(
      color("warning", `Still working: ${details.timedOut.join(", ")}`),
    );
  return lines.join("\n");
}

function defineAgentTool<T extends TSchema>(
  host: SessionHost,
  spec: AgentToolSpec<T>,
): ToolDefinition<T, AgentToolDetails> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let service: AgentService;
      try {
        service = await host.ensure(ctx);
      } catch (error) {
        throw new Error(`Agents are unavailable: ${errorMessage(error)}`);
      }
      try {
        const result = await spec.execute(
          service,
          params,
          ctx,
          signal,
          onUpdate,
        );
        return text(result.content, result.details);
      } catch (error) {
        if (error instanceof AgentError) throw new Error(error.message);
        throw error;
      }
    },
    renderCall(args, theme: Theme) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      return new Text(
        `${color("accent", AGENT_ICON)} ${theme.bold(spec.label)} ${spec.call(args as Static<T>, color)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme: Theme) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      const body = renderDetails(
        result.details as AgentToolDetails | undefined,
        options.expanded,
        color,
      );
      return new Text(body, 0, 0);
    },
  };
}

/** Wait for agents, streaming their lines as progress. */
async function waitWithProgress(
  service: AgentService,
  names: string[],
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
): Promise<{ content: string; details: AgentToolDetails }> {
  const progress = () => {
    const agents = names.flatMap((name) => service.get(name) ?? []);
    onUpdate?.(
      text(agents.map(statusLine).join("\n"), { at: Date.now(), agents }),
    );
  };
  progress();
  const timer = setInterval(progress, PROGRESS_MS);
  try {
    const outcome = await service.wait(names, {
      ...(signal ? { signal } : {}),
      ...(timeoutSeconds !== undefined
        ? { timeoutMs: timeoutSeconds * 1000 }
        : {}),
    });
    const content = outcome.agents.map(describeAgent).join("\n\n");
    return {
      content:
        outcome.timedOut.length > 0
          ? `${content}\n\nTimed out; still working: ${outcome.timedOut.join(", ")}.`
          : content,
      details: {
        at: Date.now(),
        agents: outcome.agents,
        ...(outcome.timedOut.length > 0 ? { timedOut: outcome.timedOut } : {}),
      },
    };
  } catch (error) {
    if (signal?.aborted) {
      const agents = names.flatMap((name) => service.get(name) ?? []);
      return {
        content: "Stopped waiting. The agents keep working.",
        details: { at: Date.now(), agents, message: "Stopped waiting" },
      };
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

const timeoutParam = Type.Optional(
  Type.Number({
    description: "Seconds to wait at most",
    minimum: 1,
  }),
);

export function registerAgentTools(pi: ExtensionAPI, host: SessionHost): void {
  const spawnParams = Type.Object({
    task: Type.String({
      description:
        "Self-contained task; the agent does not see this conversation",
    }),
    name: Type.Optional(
      Type.String({
        description: "Unique short name, such as a role",
      }),
    ),
    profile: Type.Optional(Type.String({ description: "Profile name" })),
    model: Type.Optional(
      Type.String({
        description: "Model as provider/id or id",
      }),
    ),
    thinking: Type.Optional(
      StringEnum(THINKING_LEVELS, { description: "Thinking level" }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description: `Tool allowlist from: ${AGENT_TOOL_NAMES.join(", ")}`,
      }),
    ),
    cwd: Type.Optional(Type.String({ description: "Working directory" })),
    wait: Type.Optional(
      Type.Boolean({
        description: "Wait for the result",
      }),
    ),
    timeout: timeoutParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      label: "spawn",
      description:
        "Start an agent on a task. Its final message is its result, which arrives as a message unless you wait for it.",
      parameters: spawnParams,
      call: (args, color) =>
        `${args.name ?? args.profile ?? "agent"}${args.profile && args.name ? color("dim", ` · ${args.profile}`) : ""}${args.task ? color("dim", `\n  ${oneLine(args.task, 160)}`) : ""}`,
      async execute(service, params, ctx, signal, onUpdate) {
        const spec = resolveSpawn(params, ctx, pi.getThinkingLevel());
        const info = await service.spawn(spec);
        if (params.wait)
          return waitWithProgress(
            service,
            [info.name],
            params.timeout,
            signal,
            onUpdate,
          );
        return {
          content: `Started ${info.name}.`,
          details: { at: Date.now(), agents: [info] },
        };
      },
    }),
  );

  const sendParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
    message: Type.String({ description: "Message" }),
    followUp: Type.Optional(
      Type.Boolean({
        description: "Queue after the current answer instead of steering",
      }),
    ),
    wait: Type.Optional(Type.Boolean({ description: "Wait for the result" })),
    timeout: timeoutParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_send",
      label: "send",
      description:
        "Send a message to an agent. A working agent receives it as steering. Its answer arrives as a message unless you wait for it.",
      parameters: sendParams,
      call: (args, color) =>
        `${args.name}${color("dim", `\n  ${oneLine(args.message ?? "", 160)}`)}`,
      async execute(service, params, _ctx, signal, onUpdate) {
        const before = service.get(params.name);
        await service.send(
          params.name,
          params.message,
          params.followUp ? "followUp" : "auto",
        );
        if (params.wait)
          return waitWithProgress(
            service,
            [params.name],
            params.timeout,
            signal,
            onUpdate,
          );
        const info = service.get(params.name) as AgentInfo;
        const verb =
          before?.state === "working"
            ? params.followUp
              ? "Queued for"
              : "Steered"
            : "Sent to";
        return {
          content: `${verb} ${info.name}.`,
          details: { at: Date.now(), agents: [info] },
        };
      },
    }),
  );

  const waitParams = Type.Object({
    names: Type.Array(Type.String(), {
      minItems: 1,
      description: "Agents to wait for",
    }),
    timeout: timeoutParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_wait",
      label: "wait",
      description: "Wait for agents to finish and return their results.",
      parameters: waitParams,
      call: (args) => (args.names ?? []).join(", "),
      execute: (service, params, _ctx, signal, onUpdate) =>
        waitWithProgress(
          service,
          params.names,
          params.timeout,
          signal,
          onUpdate,
        ),
    }),
  );

  const statusParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Agent name; omit for all" }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_status",
      label: "status",
      description: "List agents with their state and task.",
      parameters: statusParams,
      call: (args) => args.name ?? "all",
      async execute(service, params) {
        const agents = params.name
          ? [service.get(params.name)].filter(
              (info): info is AgentInfo => info !== undefined,
            )
          : service.list();
        if (params.name && agents.length === 0)
          throw new AgentError(`No agent named ${params.name}`);
        return {
          content:
            agents.length === 0
              ? "No agents."
              : agents.map(statusLine).join("\n"),
          details: { at: Date.now(), agents },
        };
      },
    }),
  );

  const nameParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_stop",
      label: "stop",
      description: "Stop an agent's current work. The agent stays available.",
      parameters: nameParams,
      call: (args) => args.name,
      async execute(service, params) {
        await service.stop(params.name);
        const info = service.get(params.name) as AgentInfo;
        return {
          content: `Stopped ${info.name}.`,
          details: { at: Date.now(), agents: [info] },
        };
      },
    }),
  );
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_close",
      label: "close",
      description: "Close an agent you no longer need.",
      parameters: nameParams,
      call: (args) => args.name,
      async execute(service, params) {
        const info = service.get(params.name);
        await service.closeAgent(params.name);
        return {
          content: `Closed ${info?.name ?? params.name}.`,
          details: { at: Date.now(), agents: [] },
        };
      },
    }),
  );
}
