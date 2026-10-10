/**
 * The parent model's tools: agent_spawn, agent_spawn_graph, agent_send,
 * agent_wait, agent_status, and agent_stop.
 */

import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import { turnResult } from "../agents/report.js";
import type { AgentService } from "../agents/service.js";
import { shapeLine } from "../agents/topology.js";
import {
  AgentError,
  type AgentInfo,
  GRAPH_SIZE,
  type GraphInfo,
  type Target,
  THINKING_LEVELS,
  WaitInterrupted,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import {
  AGENT_ICON,
  type Colorize,
  formatAgentLine,
  formatGraphLine,
  formatStartedLine,
  graphShape,
  oneLine,
} from "../ui/format.js";
import { callKey } from "./calls.js";
import {
  graphContent,
  graphResultDetails,
  nodeCounts,
  truncateResult,
} from "./messages.js";
import {
  AgentOutput,
  agentOutput,
  GraphOutput,
  graphOutput,
  type OutputLookup,
  StatusOutput,
  StopOutput,
  statusOutput,
  stopOutput,
  WaitOutput,
} from "./output.js";
import type { SessionHost } from "./session.js";
import { resolveSpawn } from "./spawn.js";

const PROGRESS_MS = 1_000;

interface AgentToolDetails {
  at: number;
  /** The call started work and reports what it started, not its state. */
  started?: boolean;
  agents: AgentInfo[];
  graphs?: GraphInfo[];
  timedOut?: string[];
  message?: string;
  /** The results the call's wait took instead of their delivery, by ID:
   * stored with the result, they count as delivered. */
  deliveries?: string[];
}

/** Learns which results a tool call returns, so they count as delivered
 * once Pi stored the call's result. */
export interface ResultClaims {
  claim(toolCallId: string, ids: readonly string[]): void;
}

function text(content: string, details: AgentToolDetails) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function lookup(service: AgentService): OutputLookup {
  return {
    agent: (id) => service.get(id),
    graph: (id) => service.getGraph(id),
  };
}

/** An agent as scripts see it now, by ID. */
function agentNow(service: AgentService, id: string): AgentOutput {
  return agentOutput(
    service.get(id) as AgentInfo,
    (graph) => service.getGraph(graph)?.name,
  );
}

/** A graph as scripts see it now, by ID. */
function graphNow(service: AgentService, id: string): GraphOutput {
  return graphOutput(service.getGraph(id) as GraphInfo, (agent) =>
    service.get(agent),
  );
}

/** The model-facing summary of one agent: its state and result. */
function describeAgent(info: AgentInfo): string {
  const head = `## ${info.name} (${info.state})`;
  const { result, error } = turnResult(info);
  if (error !== undefined) return `${head}\nError: ${error}`;
  if (info.state === "idle")
    return `${head}\n${truncateResult(result || "(empty)")}`;
  return result ? `${head}\n${truncateResult(result)}` : head;
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

/** What a call returns: text for the model, details for the UI, and its
 * output for scripts. */
interface Returned<O> {
  content: string;
  details: AgentToolDetails;
  output: O;
}

/** Which tool call runs: Pi's ID, and the key the service gets. */
interface ToolCall {
  id: string;
  /** See `callKey`; absent when the call has no ID. */
  key: string | undefined;
}

type Execute<T extends TSchema, O extends TSchema> = (
  service: AgentService,
  params: Static<T>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
  call: ToolCall,
) => Promise<Returned<Static<O>>>;

/** How a call renders: a title, the explicit arguments, and a body. */
export interface CallView {
  title: string;
  pairs?: Record<string, unknown>;
  body?: string;
  /** The body's one-line form; defaults to the body with spaces folded. */
  collapsed?: string;
}

interface AgentToolSpec<T extends TSchema, O extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  /** The schema of the output scripts get. */
  output: O;
  call: (args: Static<T>) => CallView;
  execute: Execute<T, O>;
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
    /** The text, or how to build it when it renders. */
    private readonly text: string | (() => string),
    private readonly wrap: boolean,
  ) {}

  render(width: number): string[] {
    const text = typeof this.text === "string" ? this.text : this.text();
    if (width <= 0 || !text) return [];
    if (!this.wrap)
      return text.split("\n").map((line) => truncateToWidth(line, width, "…"));
    // A wrapped line continues under its own indentation.
    return text.split("\n").flatMap((line) => {
      const indent = line.match(/^ */)?.[0] ?? "";
      const rest = line.slice(indent.length);
      if (!rest) return [""];
      return wrapTextWithAnsi(rest, Math.max(1, width - indent.length)).map(
        (part) => `${indent}${part}`,
      );
    });
  }

  invalidate(): void {
    // Stateless: every render derives from the text.
  }
}

/** What a call started, drawn right below its title. */
export interface StartedView {
  /** Appended to the title, such as ` · graph of 3`. */
  suffix?: string;
  lines: string[];
}

/** A started graph as a tree; a started agent needs nothing beyond the call. */
export function startedView(
  details: AgentToolDetails,
  color: Colorize,
): StartedView | undefined {
  const graph = details.graphs?.[0];
  if (!graph) return undefined;
  const byId = new Map(details.agents.map((info) => [info.id, info]));
  const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
  return {
    suffix: color("dim", ` · graph of ${graph.nodes.length}`),
    lines: graph.nodes.flatMap((node, index) => {
      const info = byId.get(node.agentId);
      if (!info) return [];
      const lead = index === graph.nodes.length - 1 ? "└─ " : "├─ ";
      return [
        `${color("dim", lead)}${formatStartedLine(
          info,
          color,
          node.inputs.map((input) => names.get(input) ?? input),
        )}`,
      ];
    }),
  };
}

/**
 * A call: its title, what it started right below, then a dim line of the
 * explicit arguments and the body, indented. Expanded, the body shows in
 * full, set off from what started by a blank line.
 */
export function formatCall(
  label: string,
  view: CallView,
  expanded: boolean,
  color: Colorize,
  bold: (text: string) => string = (text) => text,
  started?: StartedView,
): string {
  const lines = [
    `${color("accent", AGENT_ICON)} ${bold(label)} ${view.title}${started?.suffix ?? ""}`,
    ...(started?.lines ?? []),
  ];
  const rest: string[] = [];
  const pairs = formatPairs(view.pairs);
  if (pairs) rest.push(`  ${color("dim", pairs)}`);
  if (view.body) {
    if (expanded)
      rest.push(
        ...view.body
          .split("\n")
          .map((line) => (line ? `  ${color("muted", line)}` : "")),
      );
    else
      rest.push(
        `  ${color("muted", view.collapsed ?? view.body.replace(/\s+/g, " ").trim())}`,
      );
  }
  if (expanded && rest.length > 0 && (started?.lines.length ?? 0) > 0)
    lines.push("");
  return [...lines, ...rest].join("\n");
}

/**
 * The agents and graphs a call reports on, with their states. A call that
 * started work renders nothing here: its call shows what started, without
 * states that would only describe the moment of the call.
 */
export function renderDetails(
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

function defineAgentTool<T extends TSchema, O extends TSchema>(
  host: SessionHost,
  spec: AgentToolSpec<T, O>,
): ToolDefinition<T, AgentToolDetails> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    outputSchema: spec.output,
    prepareArguments: (args) => prepareSeconds(args) as Static<T>,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
          { id: toolCallId, key: callKey(ctx, toolCallId) },
        );
        return {
          ...text(result.content, result.details),
          structuredContent: result.output as JsonValue,
        };
      } catch (error) {
        if (error instanceof AgentError) throw new Error(error.message);
        throw error;
      }
    },
    // A call that started work shows what started below its title: the
    // result stores it in the shared state, and the call reads it when it
    // renders, after both renderers ran. An outcome replaces it.
    renderCall(args, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      const state = context.state as { started?: AgentToolDetails };
      return new FitLines(
        () =>
          formatCall(
            spec.label,
            spec.call(args as Static<T>),
            context.expanded,
            color,
            (value) => theme.bold(value),
            state.started ? startedView(state.started, color) : undefined,
          ),
        context.expanded,
      );
    },
    renderResult(result, options, theme: Theme, context) {
      const state = context.state as { started?: AgentToolDetails };
      const details = result.details as AgentToolDetails | undefined;
      // While a call waits, the panel shows the agents' live states, so the
      // call shows only what it started.
      if (options.isPartial) {
        if (details?.started) state.started = details;
        return new FitLines("", false);
      }
      // A final result alone decides what its call shows, so a replay
      // without the progress draws the same: an outcome or an error drops
      // what started, and a call that only started work sets it again.
      delete state.started;
      // An error carries no agent details: the tool threw, or Pi never ran
      // the call because the model's message broke off. Show why.
      if (context.isError || !details?.agents) {
        const reason = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
          .trim();
        return new FitLines(
          theme.fg("error", reason || "Failed"),
          options.expanded,
        );
      }
      if (details.started) {
        state.started = details;
        return new FitLines("", false);
      }
      const color: Colorize = (name, value) => theme.fg(name, value);
      return new FitLines(
        renderDetails(details, options.expanded, color),
        options.expanded,
      );
    },
  };
}

/**
 * Wait for agents, streaming their lines as progress. Progress of a call that
 * started work carries what it started, which the call draws while it waits.
 * The wait ends early when the parent is needed, such as when the user
 * steers, so Pi can place the steer instead of holding it back.
 */
async function waitWithProgress(
  service: AgentService,
  names: string[],
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
  call: { id: string; claims: ResultClaims | undefined },
  started?: AgentToolDetails,
): Promise<Returned<WaitOutput>> {
  const snapshot = () => {
    const targets = names.flatMap((name) => service.find(name) ?? []);
    const graphs = targets.flatMap((target) =>
      target.kind === "graph" ? [target.info] : [],
    );
    const agents = targets.flatMap((target) =>
      target.kind === "agent" ? [target.info] : [],
    );
    return {
      graphs,
      named: agents,
      agents: withNodes(service, graphs, agents),
    };
  };
  const progress = () => {
    const { graphs, agents } = snapshot();
    onUpdate?.(
      text(
        [
          ...graphs.map(graphStatusLine),
          ...agents.map((info) => statusLine(service, info)),
        ].join("\n"),
        started ?? { at: Date.now(), agents, graphs },
      ),
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
      // The call's result carries the results; without an ID, nothing
      // could recognize it.
      ...(call.id ? { call: call.id } : {}),
    });
    if (call.id) call.claims?.claim(call.id, outcome.deliveries);
    const content = [
      ...outcome.graphs.map((graph) => describeGraph(service, graph)),
      ...outcome.agents.map(describeAgent),
    ].join("\n\n");
    return {
      output: {
        ...statusOutput(outcome.agents, outcome.graphs, lookup(service)),
        pending: outcome.timedOut,
      },
      content:
        outcome.timedOut.length > 0
          ? `${content}\n\nTimed out; still working: ${outcome.timedOut.join(", ")}.`
          : content,
      details: {
        at: Date.now(),
        agents: withNodes(service, outcome.graphs, outcome.agents),
        ...(outcome.graphs.length > 0 ? { graphs: outcome.graphs } : {}),
        ...(outcome.timedOut.length > 0 ? { timedOut: outcome.timedOut } : {}),
        ...(outcome.deliveries.length > 0
          ? { deliveries: outcome.deliveries }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof WaitInterrupted) {
      const steered = error.reason === "attention";
      const { graphs, named, agents } = snapshot();
      return {
        output: {
          ...statusOutput(named, graphs, lookup(service)),
          pending: [
            ...named.filter(
              (info) => info.state === "working" || info.state === "waiting",
            ),
            ...graphs.filter((graph) => graph.state === "working"),
          ].map((info) => info.name),
        },
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
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Skills to load in full instead of the skill catalog; [] for none",
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
  skills?: string[];
  cwd?: string;
  delegate?: boolean;
}): Record<string, unknown> {
  return {
    profile: args.profile,
    model: args.model,
    thinking: args.thinking,
    tools: args.tools,
    skills: args.skills,
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
  claims?: ResultClaims,
): void {
  const spawnParams = Type.Object({ ...agentFields, wait: waitParam });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      label: "spawn",
      description:
        "Start an agent on a task. Its final message is its result, which arrives later as a message. Set wait to block for the result instead.",
      parameters: spawnParams,
      output: AgentOutput,
      call: (args) => ({
        title: args.name ?? "agent",
        pairs: {
          ...agentPairs(args),
          wait: seconds(args.wait),
        },
        body: args.task,
      }),
      async execute(service, params, ctx, signal, onUpdate, call) {
        const spec = await resolveSpawn(params, ctx, {
          skills: host.skills.get,
          thinking: pi.getThinkingLevel(),
        });
        const info = await service.spawn(spec, { call: call.key });
        const started = { at: Date.now(), started: true, agents: [info] };
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [info.name],
            params.wait,
            signal,
            onUpdate,
            { id: call.id, claims },
            started,
          );
          return { ...waited, output: agentNow(service, info.id) };
        }
        return {
          content: `Started ${info.name}.`,
          details: started,
          output: agentNow(service, info.id),
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
      output: GraphOutput,
      call: (args) => {
        const agents = args.agents ?? [];
        const label = (agent: { name?: string }, index: number) =>
          agent.name ?? `#${index + 1}`;
        const shape = shapeLine(
          agents.map((agent, index) => ({
            key: label(agent, index),
            inputs: agent.after ?? [],
          })),
        );
        return {
          title: args.name ?? "graph",
          pairs: {
            failFast: args.failFast,
            wait: seconds(args.wait),
          },
          // The shape, then one paragraph per agent.
          body: [
            shape,
            agents
              .map((agent, index) => {
                const pairs = formatPairs(agentPairs(agent));
                const after = agent.after?.length
                  ? ` ← ${agent.after.join(", ")}`
                  : "";
                // The task keeps its own lines, indented under the agent.
                const [first = "", ...rest] = (agent.task ?? "")
                  .trim()
                  .split("\n");
                return [
                  `${label(agent, index)}${after}${pairs ? ` (${pairs})` : ""}: ${first}`,
                  ...rest.map((line) => (line ? `  ${line}` : "")),
                ].join("\n");
              })
              .join("\n\n"),
          ].join("\n"),
          collapsed: shape,
        };
      },
      async execute(service, params, ctx, signal, onUpdate, call) {
        const thinking = pi.getThinkingLevel();
        const graph = await service.spawnGraph(
          {
            ...(params.name ? { name: params.name } : {}),
            ...(params.failFast ? { failFast: true } : {}),
            // Every agent resolves before any starts.
            agents: await Promise.all(
              params.agents.map(async (agent) => ({
                ...(await resolveSpawn(agent, ctx, {
                  skills: host.skills.get,
                  thinking,
                })),
                ...(agent.after ? { after: agent.after } : {}),
              })),
            ),
          },
          { call: call.key },
        );
        const started = {
          at: Date.now(),
          started: true,
          graphs: [graph],
          agents: withNodes(service, [graph], []),
        };
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [graph.name],
            params.wait,
            signal,
            onUpdate,
            { id: call.id, claims },
            started,
          );
          return { ...waited, output: graphNow(service, graph.id) };
        }
        return {
          content: `Started graph ${graph.name}: ${graphShape(graph)}.`,
          details: started,
          output: graphNow(service, graph.id),
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
      output: AgentOutput,
      call: (args) => ({
        title: args.name ?? "",
        pairs: {
          followUp: args.followUp,
          wait: seconds(args.wait),
        },
        body: args.message,
      }),
      async execute(service, params, _ctx, signal, onUpdate, call) {
        const before = service.get(params.name);
        const sent = await service.send(
          params.name,
          params.message,
          params.followUp ? "followUp" : "auto",
          { call: call.key },
        );
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [sent.name],
            params.wait,
            signal,
            onUpdate,
            { id: call.id, claims },
          );
          return { ...waited, output: agentNow(service, sent.id) };
        }
        const info = service.get(sent.id) as AgentInfo;
        const verb =
          before?.state === "working"
            ? params.followUp
              ? "Queued for"
              : "Steered"
            : "Sent to";
        return {
          content: `${verb} ${info.name}.`,
          details: { at: Date.now(), started: true, agents: [info] },
          output: agentNow(service, info.id),
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
      output: WaitOutput,
      call: (args) => ({
        title: (args.names ?? []).join(", "),
        pairs: {
          timeout: seconds(args.timeout),
        },
      }),
      execute: (service, params, _ctx, signal, onUpdate, call) =>
        waitWithProgress(
          service,
          params.names,
          params.timeout,
          signal,
          onUpdate,
          { id: call.id, claims },
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
      output: StatusOutput,
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
            output: statusOutput(agents, graphs, lookup(service)),
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
          output: statusOutput(agents, graphs, lookup(service)),
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
      output: StopOutput,
      call: (args) => ({ title: args.name ?? "" }),
      async execute(service, params, _ctx, _signal, _onUpdate, call) {
        const target = await service.stop(params.name, { call: call.key });
        const output = stopOutput(target);
        if (target.kind === "graph")
          return {
            content: `Stopped graph ${target.info.name} and its agents.`,
            details: {
              at: Date.now(),
              graphs: [target.info],
              agents: withNodes(service, [target.info], []),
            },
            output,
          };
        return {
          content: `Stopped ${target.info.name}.`,
          details: { at: Date.now(), agents: [target.info] },
          output,
        };
      },
    }),
  );
}
