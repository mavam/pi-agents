/**
 * The parent model's tools: agent_spawn, agent_spawn_group, agent_send,
 * agent_wait, agent_status, and agent_stop.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentService } from "../agents/service.js";
import {
  AgentError,
  type AgentInfo,
  GROUP_SIZE,
  type GroupInfo,
  type Target,
  THINKING_LEVELS,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import {
  AGENT_ICON,
  type Colorize,
  formatAgentLine,
  formatGroupLine,
  oneLine,
} from "../ui/format.js";
import {
  groupResultDetails,
  memberCounts,
  membersContent,
  truncateResult,
} from "./messages.js";
import type { SessionHost } from "./session.js";
import { resolveSpawn } from "./spawn.js";
import { SteerWatch } from "./steering.js";

const PROGRESS_MS = 1_000;

interface AgentToolDetails {
  at: number;
  agents: AgentInfo[];
  groups?: GroupInfo[];
  timedOut?: string[];
  message?: string;
}

function text(content: string, details: AgentToolDetails) {
  return { content: [{ type: "text" as const, text: content }], details };
}

/** The model-facing summary of one agent: its state and result. */
function describeAgent(info: AgentInfo): string {
  const head = `## ${info.name} (${info.state})`;
  const result = info.result;
  if (info.state === "working") return head;
  if (info.state === "failed")
    return `${head}\nError: ${result?.errorMessage ?? (result?.text || "unknown")}`;
  if (info.state === "interrupted")
    return result?.text ? `${head}\n${truncateResult(result.text)}` : head;
  return `${head}\n${truncateResult(result?.text || "(empty)")}`;
}

/** The model-facing summary of a group: each agent's state and result. */
function describeGroup(service: AgentService, group: GroupInfo): string {
  const details = groupResultDetails(group, group.members, (id) =>
    service.get(id),
  );
  if (group.state !== "working" && group.stopped)
    return `## ${group.name} (group, stopped)\n\n${membersContent(details, 3)}`;
  return `## ${group.name} (group, ${group.state === "working" ? "working: " : ""}${memberCounts(details.members)})\n\n${membersContent(details, 3)}`;
}

function statusLine(service: AgentService, info: AgentInfo): string {
  const state = info.activity.tool
    ? `${info.state}, using ${info.activity.tool}`
    : info.state;
  const group = info.group ? service.getGroup(info.group) : undefined;
  return `${info.name} (${state}${group ? `, in group ${group.name}` : ""}): ${oneLine(info.task, 120)}`;
}

function groupStatusLine(group: GroupInfo): string {
  const done = group.members.filter((member) => member.outcome).length;
  return `${group.name} (group, ${group.stopped ? "stopped" : group.state}, ${done}/${group.members.length} done): ${group.members.map((member) => member.name).join(", ")}`;
}

/** Agents to show with groups: theirs, in order, without repeats. */
function withMembers(
  service: AgentService,
  groups: readonly GroupInfo[],
  agents: readonly AgentInfo[],
): AgentInfo[] {
  const seen = new Set<string>();
  const result: AgentInfo[] = [];
  const add = (info: AgentInfo | undefined) => {
    if (!info || seen.has(info.id)) return;
    seen.add(info.id);
    result.push(info);
  };
  for (const group of groups)
    for (const member of group.members) add(service.get(member.agentId));
  for (const agent of agents) add(agent);
  return result;
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

/** How a call renders: a title, the explicit arguments, and a body. */
export interface CallView {
  title: string;
  pairs?: Record<string, unknown>;
  body?: string;
  /** The body's one-line form; defaults to the body with spaces folded. */
  collapsed?: string;
}

interface AgentToolSpec<T extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  call: (args: Static<T>) => CallView;
  execute: Execute<T>;
}

function pairValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return `[${value.map(String).join(",")}]`;
  if (typeof value === "string")
    return /^[\w./:@+,-]+$/.test(value) ? value : JSON.stringify(value);
  return String(value);
}

/** `key=value` pairs of the arguments the model set, in order. */
export function formatPairs(pairs: Record<string, unknown> = {}): string {
  return Object.entries(pairs)
    .flatMap(([key, value]) => {
      const formatted = pairValue(value);
      return formatted === undefined ? [] : [`${key}=${formatted}`];
    })
    .join(" ");
}

/**
 * Lines that wrap when expanded and otherwise end in an ellipsis at the
 * terminal width, so a collapsed call never spills onto a stray line.
 */
export class FitLines implements Component {
  constructor(
    private readonly text: string,
    private readonly wrap: boolean,
  ) {}

  render(width: number): string[] {
    if (width <= 0 || !this.text) return [];
    if (this.wrap) return new Text(this.text, 0, 0).render(width);
    return this.text
      .split("\n")
      .map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {
    // Stateless: every render derives from the text.
  }
}

/** Title line, a dim line of explicit arguments, then the body. */
export function formatCall(
  label: string,
  view: CallView,
  expanded: boolean,
  color: Colorize,
  bold: (text: string) => string = (text) => text,
): string {
  const lines = [`${color("accent", AGENT_ICON)} ${bold(label)} ${view.title}`];
  const pairs = formatPairs(view.pairs);
  if (pairs) lines.push(color("dim", `  ${pairs}`));
  if (view.body)
    lines.push(
      color(
        "muted",
        expanded
          ? view.body
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n")
          : `  ${view.collapsed ?? view.body.replace(/\s+/g, " ").trim()}`,
      ),
    );
  return lines.join("\n");
}

function renderDetails(
  details: AgentToolDetails | undefined,
  expanded: boolean,
  color: Colorize,
): string {
  if (!details) return "";
  const lines: string[] = [];
  if (details.message) lines.push(color("dim", details.message));
  const byId = new Map(details.agents.map((info) => [info.id, info]));
  const agentLines = (info: AgentInfo, indent: string) => {
    lines.push(`${indent}${formatAgentLine(info, details.at, color)}`);
    if (expanded && info.state !== "working" && info.result?.text)
      lines.push(
        ...info.result.text.split("\n").map((line) => `${indent}  ${line}`),
      );
  };
  for (const group of details.groups ?? []) {
    lines.push(formatGroupLine(group, details.at, color));
    for (const member of group.members) {
      const info = byId.get(member.agentId);
      if (!info) continue;
      byId.delete(member.agentId);
      agentLines(info, "  ");
    }
  }
  for (const info of byId.values()) agentLines(info, "");
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
    renderCall(args, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      return new FitLines(
        formatCall(
          spec.label,
          spec.call(args as Static<T>),
          context.expanded,
          color,
          (value) => theme.bold(value),
        ),
        context.expanded,
      );
    },
    renderResult(result, options, theme: Theme) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      const body = renderDetails(
        result.details as AgentToolDetails | undefined,
        options.expanded,
        color,
      );
      return new FitLines(body, options.expanded);
    },
  };
}

/**
 * Wait for agents, streaming their lines as progress. A steer from the user
 * ends the wait, so Pi can place it instead of holding it back.
 */
async function waitWithProgress(
  service: AgentService,
  steering: SteerWatch,
  names: string[],
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
): Promise<{ content: string; details: AgentToolDetails }> {
  const snapshot = () => {
    const targets = names.flatMap((name) => service.find(name) ?? []);
    const groups = targets.flatMap((target) =>
      target.kind === "group" ? [target.info] : [],
    );
    const agents = targets.flatMap((target) =>
      target.kind === "agent" ? [target.info] : [],
    );
    return { groups, agents: withMembers(service, groups, agents) };
  };
  const progress = () => {
    const { groups, agents } = snapshot();
    onUpdate?.(
      text(
        [
          ...groups.map(groupStatusLine),
          ...agents.map((info) => statusLine(service, info)),
        ].join("\n"),
        { at: Date.now(), agents, groups },
      ),
    );
  };
  progress();
  const timer = setInterval(progress, PROGRESS_MS);
  const steer = steering.open();
  try {
    const outcome = await service.wait(names, {
      signal: signal ? AbortSignal.any([signal, steer.signal]) : steer.signal,
      ...(timeoutSeconds !== undefined
        ? { timeoutMs: timeoutSeconds * 1000 }
        : {}),
    });
    const content = [
      ...outcome.groups.map((group) => describeGroup(service, group)),
      ...outcome.agents.map(describeAgent),
    ].join("\n\n");
    return {
      content:
        outcome.timedOut.length > 0
          ? `${content}\n\nTimed out; still working: ${outcome.timedOut.join(", ")}.`
          : content,
      details: {
        at: Date.now(),
        agents: withMembers(service, outcome.groups, outcome.agents),
        ...(outcome.groups.length > 0 ? { groups: outcome.groups } : {}),
        ...(outcome.timedOut.length > 0 ? { timedOut: outcome.timedOut } : {}),
      },
    };
  } catch (error) {
    const steered = steer.signal.aborted && !signal?.aborted;
    if (steered || signal?.aborted) {
      const { groups, agents } = snapshot();
      return {
        content: steered
          ? "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages."
          : "Stopped waiting. The agents keep working.",
        details: {
          at: Date.now(),
          agents,
          ...(groups.length > 0 ? { groups } : {}),
          message: steered
            ? "Stopped waiting for your message"
            : "Stopped waiting",
        },
      };
    }
    throw error;
  } finally {
    clearInterval(timer);
    steer.release();
  }
}

const waitParam = Type.Optional(
  Type.Number({
    description:
      "Block until the agent answers, at most this many seconds, and return its result",
    minimum: 1,
  }),
);

/** What one agent gets: its task and settings. */
const agentFields = {
  task: Type.String({
    description:
      "Self-contained task; the agent does not see this conversation",
  }),
  name: Type.Optional(
    Type.String({ description: "Short name, such as a role" }),
  ),
  profile: Type.Optional(Type.String({ description: "Profile name" })),
  model: Type.Optional(
    Type.String({ description: "Model, such as sonnet or opus" }),
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
};

/** The settings an agent's call line shows. */
function agentPairs(args: {
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
}): Record<string, unknown> {
  return {
    profile: args.profile,
    model: args.model,
    thinking: args.thinking,
    tools: args.tools,
    cwd: args.cwd,
  };
}

function describeTarget(service: AgentService, target: Target): string {
  return target.kind === "group"
    ? groupStatusLine(target.info)
    : statusLine(service, target.info);
}

export function registerAgentTools(
  pi: ExtensionAPI,
  host: SessionHost,
  steering: SteerWatch = new SteerWatch(),
): void {
  const spawnParams = Type.Object({ ...agentFields, wait: waitParam });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      label: "spawn",
      description:
        "Start an agent on a task. Its final message is its result, which arrives later as a message. Set wait to block for the result instead.",
      parameters: spawnParams,
      call: (args) => ({
        title: args.name ?? "agent",
        pairs: {
          ...agentPairs(args),
          wait: args.wait === undefined ? undefined : `${args.wait}s`,
        },
        body: args.task,
      }),
      async execute(service, params, ctx, signal, onUpdate) {
        const spec = resolveSpawn(params, ctx, pi.getThinkingLevel());
        const info = await service.spawn(spec);
        if (params.wait !== undefined)
          return waitWithProgress(
            service,
            steering,
            [info.name],
            params.wait,
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

  const groupParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Short name for the group" }),
    ),
    agents: Type.Array(Type.Object(agentFields), {
      minItems: GROUP_SIZE.min,
      maxItems: GROUP_SIZE.max,
      description: "One entry per agent",
    }),
    failFast: Type.Optional(
      Type.Boolean({
        description: "Stop the other agents as soon as one fails",
      }),
    ),
    wait: Type.Optional(
      Type.Number({
        description:
          "Block until every agent answers, at most this many seconds, and return their results",
        minimum: 1,
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn_group",
      label: "spawn group",
      description:
        "Start several agents in parallel on related tasks. They report back together as one message with each agent's final message. Set wait to block for the results instead.",
      parameters: groupParams,
      call: (args) => {
        const agents = args.agents ?? [];
        return {
          title: args.name ?? "group",
          pairs: {
            failFast: args.failFast,
            wait: args.wait === undefined ? undefined : `${args.wait}s`,
          },
          body: agents
            .map((agent, index) => {
              const pairs = formatPairs(agentPairs(agent));
              return `${agent.name ?? `#${index + 1}`}${pairs ? ` (${pairs})` : ""}: ${agent.task ?? ""}`;
            })
            .join("\n"),
          collapsed: agents
            .map((agent, index) => agent.name ?? `#${index + 1}`)
            .join(", "),
        };
      },
      async execute(service, params, ctx, signal, onUpdate) {
        const thinking = pi.getThinkingLevel();
        const group = await service.spawnGroup({
          ...(params.name ? { name: params.name } : {}),
          ...(params.failFast ? { failFast: true } : {}),
          agents: params.agents.map((agent) =>
            resolveSpawn(agent, ctx, thinking),
          ),
        });
        if (params.wait !== undefined)
          return waitWithProgress(
            service,
            steering,
            [group.name],
            params.wait,
            signal,
            onUpdate,
          );
        return {
          content: `Started group ${group.name}: ${group.members.map((member) => member.name).join(", ")}.`,
          details: {
            at: Date.now(),
            groups: [group],
            agents: withMembers(service, [group], []),
          },
        };
      },
    }),
  );

  const sendParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
    message: Type.String(),
    followUp: Type.Optional(
      Type.Boolean({
        description: "Queue after the current answer instead of steering",
      }),
    ),
    wait: waitParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_send",
      label: "send",
      description:
        "Send a message to an agent, also one that answered or was stopped. A working agent receives it as steering. The answer arrives later as a message. Set wait to block for it instead.",
      parameters: sendParams,
      call: (args) => ({
        title: args.name ?? "",
        pairs: {
          followUp: args.followUp,
          wait: args.wait === undefined ? undefined : `${args.wait}s`,
        },
        body: args.message,
      }),
      async execute(service, params, _ctx, signal, onUpdate) {
        const before = service.get(params.name);
        await service.send(
          params.name,
          params.message,
          params.followUp ? "followUp" : "auto",
        );
        if (params.wait !== undefined)
          return waitWithProgress(
            service,
            steering,
            [params.name],
            params.wait,
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
      description: "Agent or group names",
    }),
    timeout: Type.Optional(
      Type.Number({
        description: "Give up after this many seconds",
        minimum: 1,
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_wait",
      label: "wait",
      description:
        "Block until agents or groups answer and return their results.",
      parameters: waitParams,
      call: (args) => ({
        title: (args.names ?? []).join(", "),
        pairs: {
          timeout: args.timeout === undefined ? undefined : `${args.timeout}s`,
        },
      }),
      execute: (service, params, _ctx, signal, onUpdate) =>
        waitWithProgress(
          service,
          steering,
          params.names,
          params.timeout,
          signal,
          onUpdate,
        ),
    }),
  );

  const statusParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Agent or group name; omit for all" }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_status",
      label: "status",
      description: "List agents and groups with their state and task.",
      parameters: statusParams,
      call: (args) => ({ title: args.name ?? "all" }),
      async execute(service, params) {
        if (params.name) {
          const target = service.find(params.name);
          if (!target) throw new AgentError(`No agent named ${params.name}`);
          const groups = target.kind === "group" ? [target.info] : [];
          const agents = target.kind === "agent" ? [target.info] : [];
          return {
            content: describeTarget(service, target),
            details: {
              at: Date.now(),
              agents: withMembers(service, groups, agents),
              ...(groups.length > 0 ? { groups } : {}),
            },
          };
        }
        const groups = service.groups();
        const agents = service.list();
        const lines = [
          ...groups.map(groupStatusLine),
          ...agents.map((info) => statusLine(service, info)),
        ];
        return {
          content: lines.length === 0 ? "No agents." : lines.join("\n"),
          details: {
            at: Date.now(),
            agents: withMembers(service, groups, agents),
            ...(groups.length > 0 ? { groups } : {}),
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_stop",
      label: "stop",
      description:
        "Stop an agent or a group: end its work and remove it. Messaging an agent later starts it again.",
      parameters: Type.Object({
        name: Type.String({ description: "Agent or group name" }),
      }),
      call: (args) => ({ title: args.name ?? "" }),
      async execute(service, params) {
        const target = await service.stop(params.name);
        if (target.kind === "group")
          return {
            content: `Stopped group ${target.info.name} and its agents.`,
            details: {
              at: Date.now(),
              groups: [target.info],
              agents: withMembers(service, [target.info], []),
            },
          };
        return {
          content: `Stopped ${target.info.name}.`,
          details: { at: Date.now(), agents: [target.info] },
        };
      },
    }),
  );
}
