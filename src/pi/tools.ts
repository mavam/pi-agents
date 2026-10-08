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
  formatModelRef,
  THINKING_LEVELS,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import {
  AGENT_ICON,
  type Colorize,
  formatAgentLine,
  formatUsage,
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

/** The model-facing summary of one agent. */
export function describeAgent(info: AgentInfo): string {
  const meta = [
    info.profile,
    formatModelRef(info.model),
    info.thinking,
    formatUsage(info.usage),
  ]
    .filter(Boolean)
    .join(" · ");
  const head = `## ${info.name} (${info.state}) · ${meta}`;
  if (info.state === "working")
    return `${head}\nStill working${info.activity.tool ? ` (using ${info.activity.tool})` : ""}. Its result arrives as a message when it finishes.`;
  const result = info.result;
  if (info.state === "failed")
    return `${head}\nError: ${result?.errorMessage ?? (result?.text || "the last turn failed")}`;
  if (info.state === "stopped")
    return `${head}\nStopped before finishing.${result?.text ? ` Partial answer:\n${truncateResult(result.text)}` : ""}`;
  return `${head}\n${result ? truncateResult(result.text || "(empty answer)") : "(no answer yet)"}`;
}

function statusLine(info: AgentInfo): string {
  const parts = [
    `${info.name}: ${info.state}`,
    info.profile,
    formatModelRef(info.model),
    formatUsage(info.usage),
    info.activity.tool ? `using ${info.activity.tool}` : undefined,
    `task: ${oneLine(info.task, 120)}`,
  ];
  return parts.filter(Boolean).join(" · ");
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
  promptSnippet: string;
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
    promptSnippet: spec.promptSnippet,
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
          ? `${content}\n\nTimed out while ${outcome.timedOut.join(", ")} kept working.`
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
        content: `Stopped waiting. ${agents.map((agent) => `${agent.name} is ${agent.state}`).join("; ")}. Results arrive as messages.`,
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
    description: "Seconds to wait before returning while agents still work",
    minimum: 1,
  }),
);

export function registerAgentTools(pi: ExtensionAPI, host: SessionHost): void {
  const spawnParams = Type.Object({
    task: Type.String({
      description:
        "Self-contained task. The agent does not see this conversation.",
    }),
    name: Type.Optional(
      Type.String({
        description:
          "Short role name, unique among open agents (letters, digits, . _ -)",
      }),
    ),
    profile: Type.Optional(
      Type.String({ description: "Agent profile to apply" }),
    ),
    model: Type.Optional(
      Type.String({
        description: "Model as provider/id or id; defaults to this session's",
      }),
    ),
    thinking: Type.Optional(
      StringEnum(THINKING_LEVELS, { description: "Thinking level" }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description: `Tool allowlist from: ${AGENT_TOOL_NAMES.join(", ")}. Default: read, bash, edit, write.`,
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory; defaults to this one" }),
    ),
    wait: Type.Optional(
      Type.Boolean({
        description: "Block until the agent finishes and return its result",
      }),
    ),
    timeout: timeoutParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      label: "spawn",
      description:
        "Start a durable agent on a task. It works in the background; its result arrives as a message when it finishes unless you wait for it.",
      promptSnippet: "Start a background agent on a self-contained task",
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
        const meta = [info.profile, formatModelRef(info.model), info.thinking]
          .filter(Boolean)
          .join(" · ");
        return {
          content: `Started agent "${info.name}" (${meta}). It works in the background; its result arrives as a message when it finishes. Use agent_wait to block on it.`,
          details: { at: Date.now(), agents: [info] },
        };
      },
    }),
  );

  const sendParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
    message: Type.String({ description: "Message for the agent" }),
    followUp: Type.Optional(
      Type.Boolean({
        description:
          "Queue after the current answer instead of steering a working agent",
      }),
    ),
    wait: Type.Optional(
      Type.Boolean({ description: "Block until the agent finishes" }),
    ),
    timeout: timeoutParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_send",
      label: "send",
      description:
        "Message an agent. An idle agent starts a new turn; a working agent receives it as steering, or after its current answer with followUp.",
      promptSnippet: "Message an agent to steer it or follow up",
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
              ? "Queued a follow-up for"
              : "Steered"
            : "Prompted";
        return {
          content: `${verb} ${info.name}. Its result arrives as a message when it finishes.`,
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
      description:
        "Block until the named agents are idle and return their results. Cancelling the wait leaves the agents working.",
      promptSnippet: "Wait for agents and return their results",
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
      Type.String({ description: "Agent name; omit for all open agents" }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_status",
      label: "status",
      description:
        "Show the state of agents. Results arrive as messages on their own, so do not poll.",
      promptSnippet: "Show agent states",
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
              ? "No open agents."
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
      description:
        "Abort an agent's current work and drop its queued messages. The agent stays open for further messages.",
      promptSnippet: "Abort an agent's current work",
      parameters: nameParams,
      call: (args) => args.name,
      async execute(service, params) {
        await service.stop(params.name);
        const info = service.get(params.name) as AgentInfo;
        return {
          content: `Stopped ${info.name}. It stays open; message it with agent_send or close it with agent_close.`,
          details: { at: Date.now(), agents: [info] },
        };
      },
    }),
  );
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_close",
      label: "close",
      description:
        "Stop an agent and close it. Use this once you no longer need the agent.",
      promptSnippet: "Close an agent you no longer need",
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
