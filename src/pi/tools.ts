/**
 * The parent model's tools: agent_spawn, agent_spawn_graph, agent_send,
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
import { shapeLine } from "../agents/topology.js";
import {
  AgentError,
  type AgentInfo,
  GRAPH_SIZE,
  type GraphInfo,
  type Target,
  THINKING_LEVELS,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import {
  AGENT_ICON,
  type Colorize,
  formatAgentLine,
  formatGraphLine,
  graphShape,
  oneLine,
} from "../ui/format.js";
import {
  graphContent,
  graphResultDetails,
  nodeCounts,
  truncateResult,
} from "./messages.js";
import type { SessionHost } from "./session.js";
import { resolveSpawn } from "./spawn.js";
import { SteerWatch } from "./steering.js";

const PROGRESS_MS = 1_000;

interface AgentToolDetails {
  at: number;
  agents: AgentInfo[];
  graphs?: GraphInfo[];
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

/** The model-facing summary of a graph: its result once it finished. */
function describeGraph(service: AgentService, graph: GraphInfo): string {
  const details = graphResultDetails(graph, graph.nodes, (id) =>
    service.get(id),
  );
  if (graph.stopped) return `Graph ${graph.name} was stopped.`;
  if (graph.state === "working")
    return `Graph ${graph.name} is still working: ${nodeCounts(details.nodes)}.`;
  return graphContent(details);
}

function statusLine(service: AgentService, info: AgentInfo): string {
  const delegation = info.activity.delegation;
  const state = delegation
    ? `${info.state}, waiting for its helpers ${delegation.graph} (${delegation.done}/${delegation.total} done)`
    : info.activity.tool
      ? `${info.state}, using ${info.activity.tool}`
      : info.state;
  const graph = info.graph ? service.getGraph(info.graph) : undefined;
  return `${info.name} (${state}${graph ? `, in graph ${graph.name}` : ""}): ${oneLine(info.task, 120)}`;
}

function graphStatusLine(graph: GraphInfo): string {
  const done = graph.nodes.filter((node) => node.outcome).length;
  return `${graph.name} (graph, ${graph.stopped ? "stopped" : graph.state}, ${done}/${graph.nodes.length} done): ${graphShape(graph)}`;
}

/** Agents to show with graphs: theirs, in order, without repeats. */
function withNodes(
  service: AgentService,
  graphs: readonly GraphInfo[],
  agents: readonly AgentInfo[],
): AgentInfo[] {
  const seen = new Set<string>();
  const result: AgentInfo[] = [];
  const add = (info: AgentInfo | undefined) => {
    if (!info || seen.has(info.id)) return;
    seen.add(info.id);
    result.push(info);
  };
  for (const graph of graphs)
    for (const node of graph.nodes) add(service.get(node.agentId));
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
  const agentLines = (
    info: AgentInfo,
    lead: string,
    indent: string,
    inputs: string[] = [],
  ) => {
    lines.push(
      `${color("dim", lead)}${formatAgentLine(info, details.at, color, inputs)}`,
    );
    if (expanded && info.state !== "working" && info.result?.text)
      lines.push(
        ...info.result.text
          .split("\n")
          .map((line) => `${color("dim", indent)}  ${line}`),
      );
  };
  for (const graph of details.graphs ?? []) {
    lines.push(formatGraphLine(graph, details.at, color));
    const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
    graph.nodes.forEach((node, index) => {
      const info = byId.get(node.agentId);
      if (!info) return;
      byId.delete(node.agentId);
      const last = index === graph.nodes.length - 1;
      agentLines(
        info,
        last ? "└─ " : "├─ ",
        last ? "   " : "│  ",
        node.inputs.map((input) => names.get(input) ?? input),
      );
    });
  }
  for (const info of byId.values()) agentLines(info, "", "");
  if (details.timedOut && details.timedOut.length > 0)
    lines.push(
      color("warning", `Still working: ${details.timedOut.join(", ")}`),
    );
  return lines.join("\n");
}

/**
 * Models sometimes write `wait: false` for "don't wait" or quote numbers.
 * Seconds that aren't a positive number mean no wait; numeric strings count.
 */
/** A number of seconds, if the value is a positive number or its string. */
function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/** `120s` for a call line; nothing for what prepareSeconds drops. */
function seconds(value: unknown): string | undefined {
  const parsed = positiveSeconds(value);
  return parsed === undefined ? undefined : `${parsed}s`;
}

/**
 * Models sometimes write `wait: false` for "don't wait" or quote numbers.
 * Seconds that aren't a positive number mean no wait; numeric strings count.
 */
export function prepareSeconds(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const prepared: Record<string, unknown> = { ...args };
  for (const key of ["wait", "timeout"]) {
    if (!(key in prepared)) continue;
    const parsed = positiveSeconds(prepared[key]);
    if (parsed === undefined) delete prepared[key];
    else prepared[key] = parsed;
  }
  return prepared;
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
    prepareArguments: (args) => prepareSeconds(args) as Static<T>,
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
    const graphs = targets.flatMap((target) =>
      target.kind === "graph" ? [target.info] : [],
    );
    const agents = targets.flatMap((target) =>
      target.kind === "agent" ? [target.info] : [],
    );
    return { graphs, agents: withNodes(service, graphs, agents) };
  };
  const progress = () => {
    const { graphs, agents } = snapshot();
    onUpdate?.(
      text(
        [
          ...graphs.map(graphStatusLine),
          ...agents.map((info) => statusLine(service, info)),
        ].join("\n"),
        { at: Date.now(), agents, graphs },
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
      ...outcome.graphs.map((graph) => describeGraph(service, graph)),
      ...outcome.agents.map(describeAgent),
    ].join("\n\n");
    return {
      content:
        outcome.timedOut.length > 0
          ? `${content}\n\nTimed out; still working: ${outcome.timedOut.join(", ")}.`
          : content,
      details: {
        at: Date.now(),
        agents: withNodes(service, outcome.graphs, outcome.agents),
        ...(outcome.graphs.length > 0 ? { graphs: outcome.graphs } : {}),
        ...(outcome.timedOut.length > 0 ? { timedOut: outcome.timedOut } : {}),
      },
    };
  } catch (error) {
    const steered = steer.signal.aborted && !signal?.aborted;
    if (steered || signal?.aborted) {
      const { graphs, agents } = snapshot();
      return {
        content: steered
          ? "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages."
          : "Stopped waiting. The agents keep working.",
        details: {
          at: Date.now(),
          agents,
          ...(graphs.length > 0 ? { graphs } : {}),
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
  delegate: Type.Optional(
    Type.Boolean({
      description:
        "Let the agent split its task among helper agents it starts and waits for",
    }),
  ),
};

/** The settings an agent's call line shows. */
function agentPairs(args: {
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
  delegate?: boolean;
}): Record<string, unknown> {
  return {
    profile: args.profile,
    model: args.model,
    thinking: args.thinking,
    tools: args.tools,
    cwd: args.cwd,
    delegate: args.delegate,
  };
}

function describeTarget(service: AgentService, target: Target): string {
  return target.kind === "graph"
    ? graphStatusLine(target.info)
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
          wait: seconds(args.wait),
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

  const graphParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Short name for the graph" }),
    ),
    agents: Type.Array(
      Type.Object({
        ...agentFields,
        after: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Names of agents in this graph whose final messages this agent needs; it starts once they finished and receives their results",
          }),
        ),
      }),
      {
        minItems: GRAPH_SIZE.min,
        maxItems: GRAPH_SIZE.max,
        description: "One entry per agent",
      },
    ),
    failFast: Type.Optional(
      Type.Boolean({
        description: "Stop the other agents as soon as one fails",
      }),
    ),
    wait: Type.Optional(
      Type.Number({
        description:
          "Block until the graph finishes, at most this many seconds, and return its result",
        minimum: 1,
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn_graph",
      label: "spawn graph",
      description:
        "Start agents that work together on related tasks. Agents run in parallel; one that lists others in after starts once they finished and receives their final messages. The final messages of the agents nothing waits for come back as one message, so to get one merged answer, add an agent after all the others that merges their results. Set wait to block for the result instead.",
      parameters: graphParams,
      call: (args) => {
        const agents = args.agents ?? [];
        const label = (agent: { name?: string }, index: number) =>
          agent.name ?? `#${index + 1}`;
        return {
          title: args.name ?? "graph",
          pairs: {
            failFast: args.failFast,
            wait: seconds(args.wait),
          },
          body: agents
            .map((agent, index) => {
              const pairs = formatPairs(agentPairs(agent));
              const after = agent.after?.length
                ? ` ← ${agent.after.join(", ")}`
                : "";
              return `${label(agent, index)}${after}${pairs ? ` (${pairs})` : ""}: ${agent.task ?? ""}`;
            })
            .join("\n"),
          collapsed: shapeLine(
            agents.map((agent, index) => ({
              key: label(agent, index),
              inputs: agent.after ?? [],
            })),
          ),
        };
      },
      async execute(service, params, ctx, signal, onUpdate) {
        const thinking = pi.getThinkingLevel();
        const graph = await service.spawnGraph({
          ...(params.name ? { name: params.name } : {}),
          ...(params.failFast ? { failFast: true } : {}),
          agents: params.agents.map((agent) => ({
            ...resolveSpawn(agent, ctx, thinking),
            ...(agent.after ? { after: agent.after } : {}),
          })),
        });
        if (params.wait !== undefined)
          return waitWithProgress(
            service,
            steering,
            [graph.name],
            params.wait,
            signal,
            onUpdate,
          );
        return {
          content: `Started graph ${graph.name}: ${graphShape(graph)}.`,
          details: {
            at: Date.now(),
            graphs: [graph],
            agents: withNodes(service, [graph], []),
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
          wait: seconds(args.wait),
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
      description: "Agent or graph names",
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
        "Block until agents or graphs answer and return their results.",
      parameters: waitParams,
      call: (args) => ({
        title: (args.names ?? []).join(", "),
        pairs: {
          timeout: seconds(args.timeout),
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
      Type.String({ description: "Agent or graph name; omit for all" }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_status",
      label: "status",
      description: "List agents and graphs with their state and task.",
      parameters: statusParams,
      call: (args) => ({ title: args.name ?? "all" }),
      async execute(service, params) {
        if (params.name) {
          const target = service.find(params.name);
          if (!target) throw new AgentError(`No agent named ${params.name}`);
          const graphs = target.kind === "graph" ? [target.info] : [];
          const agents = target.kind === "agent" ? [target.info] : [];
          return {
            content: describeTarget(service, target),
            details: {
              at: Date.now(),
              agents: withNodes(service, graphs, agents),
              ...(graphs.length > 0 ? { graphs } : {}),
            },
          };
        }
        const graphs = service.graphs();
        const agents = service.list();
        const lines = [
          ...graphs.map(graphStatusLine),
          ...agents.map((info) => statusLine(service, info)),
        ];
        return {
          content: lines.length === 0 ? "No agents." : lines.join("\n"),
          details: {
            at: Date.now(),
            agents: withNodes(service, graphs, agents),
            ...(graphs.length > 0 ? { graphs } : {}),
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
        "Stop an agent or a graph: end its work and remove it. Messaging an agent later starts it again.",
      parameters: Type.Object({
        name: Type.String({ description: "Agent or graph name" }),
      }),
      call: (args) => ({ title: args.name ?? "" }),
      async execute(service, params) {
        const target = await service.stop(params.name);
        if (target.kind === "graph")
          return {
            content: `Stopped graph ${target.info.name} and its agents.`,
            details: {
              at: Date.now(),
              graphs: [target.info],
              agents: withNodes(service, [target.info], []),
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
