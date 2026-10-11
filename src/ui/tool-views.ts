/**
 * How agent tool calls look, in Pi's transcript and in the attach view. A
 * presentation draws calls and results; it doesn't run them, and it never
 * looks at live agents:
 *
 * - The call draws its arguments only: a title, a dim line of `key=value`
 *   pairs, and the body, such as a task.
 * - The result draws its receipt only (see `src/agents/receipts.ts`):
 *   progress draws what the call started, the final result how agents and
 *   graphs were when the call looked, and why its wait ended.
 *
 * Neither shares state with the other, so a call draws the same while it
 * runs, after it finished, and when a session replays it. Pi's transcript
 * and the attach view each have their own map from tool name to renderers,
 * because the parent's tools and the agents' tools differ.
 */

import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type AgentReceipt,
  asReceipt,
  type GraphReceipt,
  isFinished,
  observed,
  receipt,
  startedGraph,
  type ToolReceipt,
} from "../agents/receipts.js";
import type { NodeKind } from "../agents/report.js";
import { shapeLine } from "../agents/topology.js";
import type { AgentInfo, GraphInfo } from "../agents/types.js";
import {
  AGENT_ICON,
  type Colorize,
  formatUsage,
  oneLine,
  STATE_STYLES,
  WAIT_ENDED_STYLE,
} from "./format.js";
import { messageCard } from "./messages.js";

/** How a call renders: a title, the explicit arguments, and a body. */
export interface CallView {
  title: string;
  pairs?: Record<string, unknown>;
  body?: string;
  /** The body's one-line form; defaults to the body with spaces folded. */
  collapsed?: string;
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

/** A number of seconds, if the value is a positive number or its string. */
export function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/** `120s` for a call line; nothing for seconds a call ignores. */
function seconds(value: unknown): string | undefined {
  const parsed = positiveSeconds(value);
  return parsed === undefined ? undefined : `${parsed}s`;
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
    if (!this.wrap)
      return this.text
        .split("\n")
        .map((line) => truncateToWidth(line, width, "…"));
    // A wrapped line continues under its own indentation.
    return this.text.split("\n").flatMap((line) => {
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

/**
 * A call: its title, then a dim line of the explicit arguments and the
 * body, indented. Expanded, the body shows in full.
 */
export function formatCall(
  label: string,
  view: CallView,
  expanded: boolean,
  color: Colorize,
  bold: (text: string) => string = (text) => text,
): string {
  const lines = [`${color("accent", AGENT_ICON)} ${bold(label)} ${view.title}`];
  const pairs = formatPairs(view.pairs);
  if (pairs) lines.push(`  ${color("dim", pairs)}`);
  if (view.body) {
    if (expanded)
      lines.push(
        ...view.body
          .split("\n")
          .map((line) => (line ? `  ${color("muted", line)}` : "")),
      );
    else
      lines.push(
        `  ${color("muted", view.collapsed ?? view.body.replace(/\s+/g, " ").trim())}`,
      );
  }
  return lines.join("\n");
}

// --- Call views: arguments only ---

interface AgentArgs {
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  cwd?: string;
  delegate?: boolean;
}

/** The settings an agent's call line shows. */
function agentPairs(args: AgentArgs): Record<string, unknown> {
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

interface GraphArgs {
  name?: string;
  failFast?: boolean;
  wait?: unknown;
  agents?: Array<
    AgentArgs & { name?: string; task?: string; after?: string[] }
  >;
}

/** A graph call: its shape collapsed, one paragraph per agent expanded. */
function graphCall(args: GraphArgs, fallback: string): CallView {
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
    title: args.name ?? fallback,
    pairs: { failFast: args.failFast, wait: seconds(args.wait) },
    body: [
      shape,
      agents
        .map((agent, index) => {
          const pairs = formatPairs(agentPairs(agent));
          const after = agent.after?.length
            ? ` ← ${agent.after.join(", ")}`
            : "";
          // The task keeps its own lines, indented under the agent.
          const [first = "", ...rest] = (agent.task ?? "").trim().split("\n");
          return [
            `${label(agent, index)}${after}${pairs ? ` (${pairs})` : ""}: ${first}`,
            ...rest.map((line) => (line ? `  ${line}` : "")),
          ].join("\n");
        })
        .join("\n\n"),
    ].join("\n"),
    collapsed: shape,
  };
}

type Args = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

interface ToolView {
  label: string;
  call: (args: Args) => CallView;
  /** What a result without agents or graphs says. */
  empty?: string;
}

/** The parent's tools: their labels and call views. */
const PARENT_CALLS: Record<string, ToolView> = {
  agent_spawn: {
    label: "spawn",
    call: (args) => ({
      title: str(args.name) || "agent",
      pairs: { ...agentPairs(args as AgentArgs), wait: seconds(args.wait) },
      body: str(args.task),
    }),
  },
  agent_spawn_graph: {
    label: "spawn graph",
    call: (args) => graphCall(args as GraphArgs, "graph"),
  },
  agent_send: {
    label: "send",
    call: (args) => ({
      title: str(args.name),
      pairs: { followUp: args.followUp, wait: seconds(args.wait) },
      body: str(args.message),
    }),
  },
  agent_wait: {
    label: "wait",
    call: (args) => ({
      title: (Array.isArray(args.names) ? args.names : []).join(", "),
      pairs: { timeout: seconds(args.timeout) },
    }),
  },
  agent_status: {
    label: "status",
    call: (args) => ({ title: str(args.name) || "all" }),
    empty: "No agents",
  },
  agent_stop: {
    label: "stop",
    call: (args) => ({ title: str(args.name) }),
  },
};

/** The agents' own tools. */
const AGENT_CALLS: typeof PARENT_CALLS = {
  delegate_graph: {
    label: "delegate",
    call: (args) => graphCall(args as GraphArgs, "helpers"),
  },
  agent_status: {
    label: "status",
    call: () => ({ title: "agents" }),
    empty: "No other agents",
  },
};

// --- Results: receipts only ---

const OUTCOME_STYLES: Record<
  NodeKind,
  { icon: string; color: Parameters<Colorize>[0] }
> = {
  answered: STATE_STYLES.idle,
  failed: STATE_STYLES.failed,
  interrupted: STATE_STYLES.interrupted,
  stopped: STATE_STYLES.interrupted,
  skipped: STATE_STYLES.skipped,
  working: STATE_STYLES.working,
  waiting: STATE_STYLES.waiting,
};

const WAIT_NOTES = {
  timeout: { text: "Timed out", color: "warning" },
  attention: { text: "Stopped waiting for your message", color: "dim" },
  cancelled: { text: "Stopped waiting", color: "dim" },
} as const;

/**
 * The glyph of a row: none for what the call only started, `⊠` for what a
 * wait gave up on, and otherwise the outcome the call saw.
 */
function glyph(
  outcome: NodeKind | undefined,
  receipt: ToolReceipt,
  color: Colorize,
): string {
  if (outcome === undefined) return "";
  const gaveUp =
    !isFinished(outcome) &&
    receipt.wait !== undefined &&
    receipt.wait !== "done";
  const style = gaveUp ? WAIT_ENDED_STYLE : OUTCOME_STYLES[outcome];
  return `${color(style.color, style.icon)} `;
}

function agentRow(
  agent: AgentReceipt,
  receipt: ToolReceipt,
  color: Colorize,
  expanded = false,
): string {
  const dot = color("dim", " · ");
  const inputs = agent.inputs?.length
    ? color("dim", ` ← ${agent.inputs.join(", ")}`)
    : "";
  const usage = agent.usage ? formatUsage(agent.usage) : "";
  const error =
    agent.outcome === "failed" && agent.body
      ? color("error", oneLine(agent.body, 120))
      : undefined;
  return [
    `${glyph(agent.outcome, receipt, color)}${agent.name}${inputs}`,
    agent.profile ? color("dim", agent.profile) : undefined,
    agent.model ? color("dim", agent.model) : undefined,
    usage ? color("dim", usage) : undefined,
    agent.task && !expanded
      ? color("dim", oneLine(agent.task, 120))
      : undefined,
    error,
  ]
    .filter((part): part is string => part !== undefined)
    .join(dot);
}

/** `1 failed, 2 stopped`: how many of a graph's agents didn't answer. */
function graphNote(graph: GraphReceipt): string | undefined {
  if (graph.outcome === "stopped") return "stopped";
  const note = (["failed", "interrupted", "stopped", "skipped"] as const)
    .flatMap((kind) => {
      const count = graph.agents.filter(
        (agent) => agent.outcome === kind,
      ).length;
      return count > 0 ? [`${count} ${kind}`] : [];
    })
    .join(", ");
  return note || undefined;
}

function graphRow(
  graph: GraphReceipt,
  receipt: ToolReceipt,
  color: Colorize,
): string {
  const dot = color("dim", " · ");
  const total = graph.agents.length;
  if (graph.outcome === undefined)
    return `${graph.name}${dot}${color("dim", `graph of ${total}`)}`;
  const done = graph.agents.filter((agent) => isFinished(agent.outcome)).length;
  const usage = graph.usage ? formatUsage(graph.usage) : "";
  const note = isFinished(graph.outcome) ? graphNote(graph) : undefined;
  return [
    `${glyph(graph.outcome, receipt, color)}${graph.name}`,
    color("dim", `graph ${done}/${total}`),
    usage ? color("dim", usage) : undefined,
    note
      ? color(graph.outcome === "failed" ? "error" : "dim", note)
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(dot);
}

/** A receipt's lines: graphs as trees, then agents, then how the wait
 * ended. Expanded, answers show below their agents. */
export function formatReceipt(
  receipt: ToolReceipt,
  expanded: boolean,
  color: Colorize,
): string {
  const lines: string[] = [];
  const agentLines = (agent: AgentReceipt, lead: string, indent: string) => {
    lines.push(
      `${color("dim", lead)}${agentRow(agent, receipt, color, expanded)}`,
    );
    // Expanded, a task shows in full below its agent.
    if (expanded && agent.task)
      lines.push(
        ...agent.task
          .split("\n")
          .map((line) => `${color("dim", indent)}  ${color("muted", line)}`),
      );
    if (
      expanded &&
      agent.body &&
      agent.outcome !== undefined &&
      agent.outcome !== "failed"
    )
      lines.push(
        ...agent.body
          .split("\n")
          .map((line) => `${color("dim", indent)}  ${line}`),
      );
  };
  for (const graph of receipt.graphs) {
    lines.push(graphRow(graph, receipt, color));
    graph.agents.forEach((agent, index) => {
      const last = index === graph.agents.length - 1;
      agentLines(agent, last ? "└─ " : "├─ ", last ? "   " : "│  ");
    });
  }
  for (const agent of receipt.agents) agentLines(agent, "", "");
  if (receipt.wait && receipt.wait !== "done") {
    const note = WAIT_NOTES[receipt.wait];
    lines.push(color(note.color, note.text));
  }
  return lines.join("\n");
}

// --- Stored results ---

/**
 * The receipt of a stored result. Results of earlier versions stored live
 * agent records instead; they read as what they showed: what a call
 * started, or how agents were when it returned.
 */
export function decodeReceipt(details: unknown): ToolReceipt | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const stored = (details as { receipt?: unknown }).receipt;
  if (stored !== undefined) return asReceipt(stored);
  const legacy = details as {
    started?: unknown;
    agents?: unknown;
    graphs?: unknown;
    timedOut?: unknown;
    message?: unknown;
  };
  if (!Array.isArray(legacy.agents)) return undefined;
  try {
    const agents = legacy.agents as AgentInfo[];
    const graphs = (
      Array.isArray(legacy.graphs) ? legacy.graphs : []
    ) as GraphInfo[];
    const byId = new Map(agents.map((info) => [info.id, info]));
    const lookup = (id: string) => byId.get(id);
    if (legacy.started === true)
      return receipt({
        graphs: graphs.map((graph) => startedGraph(graph, lookup)),
      });
    const wait =
      Array.isArray(legacy.timedOut) && legacy.timedOut.length > 0
        ? "timeout"
        : legacy.message === WAIT_NOTES.attention.text
          ? "attention"
          : legacy.message === WAIT_NOTES.cancelled.text
            ? "cancelled"
            : undefined;
    return observed(graphs, agents, lookup, wait);
  } catch {
    return undefined;
  }
}

/** The text of a result. */
function resultText(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

/** Renderers of one tool: the call from its arguments, the result from its
 * receipt, an error from its text. */
function toolRenderers({ label, call, empty }: ToolView): ToolRenderers {
  return {
    renderCall(args, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      return new FitLines(
        formatCall(
          label,
          call((args ?? {}) as Args),
          context.expanded,
          color,
          (value) => theme.bold(value),
        ),
        context.expanded,
      );
    },
    renderResult(result, options, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      // An error carries no receipt: the tool threw, or Pi never ran the
      // call because the model's message broke off. Show why.
      if (context.isError)
        return new FitLines(
          theme.fg("error", resultText(result) || "Failed"),
          options.expanded,
        );
      const decoded = decodeReceipt(result.details);
      // A result this version can't read shows its text.
      if (!decoded) {
        const text = resultText(result);
        return new FitLines(
          color("dim", options.expanded ? text : (text.split("\n")[0] ?? "")),
          options.expanded,
        );
      }
      const lines = formatReceipt(decoded, options.expanded, color);
      return new FitLines(
        lines || (empty ? color("dim", empty) : ""),
        options.expanded,
      );
    },
  };
}

function views(
  calls: Record<string, ToolView>,
): Record<string, ToolRenderers & { label: string }> {
  return Object.fromEntries(
    Object.entries(calls).map(([name, view]) => [
      name,
      { label: view.label, ...toolRenderers(view) },
    ]),
  );
}

/** Renderers of the parent's tools in Pi's transcript. */
export const PARENT_TOOL_VIEWS = views(PARENT_CALLS);

/**
 * An agent's `agent_send` call as the message it sent, a card like the
 * recipient's, and a refusal below it. `sender` names the agent.
 */
function sendView(sender: () => string): ToolRenderers & { label: string } {
  return {
    label: "send",
    renderShell: "self",
    renderCall: (args, theme: Theme, context) =>
      messageCard(
        {
          from: sender(),
          to: str((args as Args | undefined)?.to) || "?",
          text: str((args as Args | undefined)?.message),
        },
        context.expanded,
        theme,
      ),
    renderResult: (result, _options, theme: Theme, context) =>
      context.isError
        ? new Text(
            theme.fg("error", `  ✘ ${resultText(result) || "not sent"}`),
            1,
            0,
          )
        : new Container(),
  };
}

/** Renderers of the agents' own tools in the attach view of the agent
 * `self` names. */
export function agentToolViews(
  self: () => string,
): Record<string, ToolRenderers & { label: string }> {
  return { ...views(AGENT_CALLS), agent_send: sendView(self) };
}
