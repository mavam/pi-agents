/**
 * How agent tool calls look, in Pi's transcript and in the attach view. A
 * presentation draws calls and results; it doesn't run them, and it never
 * looks at live agents:
 *
 * - The call draws its arguments only: the tool's name in bold, as Pi draws
 *   its own tools, a title, a dim line of `key=value` pairs, and the body,
 *   such as a job.
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
  type ToolReceipt,
} from "../agents/receipts.js";
import type { NodeKind } from "../agents/report.js";
import { shapeLine } from "../agents/topology.js";
import { messageMode } from "../agents/types.js";
import {
  type Colorize,
  formatInputs,
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

/** A send's mode for its call line, also of calls from before `mode`
 * existed, which set `followUp`; nothing for the default. */
function sendModePair(args: Args): string | undefined {
  const mode = messageMode(args);
  return mode === "steer" ? undefined : mode;
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
 * A call: its name, styled by `name`, and its title with the explicit
 * arguments dim after it, then the body, indented. Expanded, the body
 * shows in full.
 */
export function formatCall(
  label: string,
  view: CallView,
  expanded: boolean,
  color: Colorize,
  name: (text: string) => string = (text) => text,
): string {
  // The explicit arguments follow the title, dim, on the same line.
  const pairs = formatPairs(view.pairs);
  const lines = [
    `${name(label)} ${view.title}${pairs ? ` ${color("dim", pairs)}` : ""}`,
  ];
  if (view.body) {
    if (expanded)
      lines.push(
        ...view.body
          .split("\n")
          .map((line) => (line ? `  ${color("muted", line)}` : "")),
      );
    else {
      const collapsed = view.collapsed ?? view.body.replace(/\s+/g, " ").trim();
      if (collapsed) lines.push(`  ${color("muted", collapsed)}`);
    }
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
  spawn?: boolean;
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
    spawn: args.spawn,
  };
}

interface GraphArgs {
  name?: string;
  failFast?: boolean;
  wait?: unknown;
  agents?: Array<AgentArgs & { name?: string; job?: string; after?: string[] }>;
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
            ? ` after ${agent.after.join(", ")}`
            : "";
          // The job keeps its own lines, indented under the agent.
          const [first = "", ...rest] = (agent.job ?? "").trim().split("\n");
          return [
            `${label(agent, index)}${after}${pairs ? ` (${pairs})` : ""}: ${first}`,
            ...rest.map((line) => (line ? `  ${line}` : "")),
          ].join("\n");
        })
        .join("\n\n"),
    ].join("\n"),
    // Collapsed, the result's tree shows the agents and who waits for whom.
    collapsed: "",
  };
}

type Args = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * A spawn call: one agent reads as that agent, its job as the body, and
 * several as a graph.
 */
function spawnCall(args: Args, fallback: string): CallView {
  const graph = args as GraphArgs;
  const agents = graph.agents ?? [];
  const [only] = agents;
  if (agents.length !== 1 || !only) return graphCall(graph, fallback);
  return {
    title: str(only.name) || str(graph.name) || "agent",
    pairs: {
      ...agentPairs(only),
      failFast: graph.failFast,
      wait: seconds(graph.wait),
    },
    body: str(only.job),
  };
}

interface ToolView {
  label: string;
  call: (args: Args) => CallView;
  /** What a result without agents or graphs says. */
  empty?: string;
  /** The call starts the work it reports on, so what hasn't finished is
   * only what it started: no state, which would go stale. */
  starts?: true;
  /** A note below the result while the call still runs. */
  running?: string;
}

/** What a call that started work shows of what hasn't finished: only that
 * it started, without a state. */
function asStarted(receipt: ToolReceipt): ToolReceipt {
  const started = <T extends { outcome?: NodeKind }>(item: T): T => {
    if (isFinished(item.outcome)) return item;
    const { outcome: _, ...rest } = item;
    return rest as T;
  };
  return {
    ...receipt,
    graphs: receipt.graphs.map((graph) => ({
      ...started(graph),
      agents: graph.agents.map(started),
    })),
    agents: receipt.agents.map(started),
  };
}

/** A wait names what it waits for; without names, all. */
function waitCall(args: Args): CallView {
  const names = Array.isArray(args.names) ? args.names.map(String) : [];
  return {
    title: names.join(", ") || "all",
    pairs: { timeout: seconds(args.timeout) },
  };
}

/** The parent's tools: their labels and call views. */
const PARENT_CALLS: Record<string, ToolView> = {
  agent_spawn: {
    label: "spawn",
    starts: true,
    call: (args) => spawnCall(args, "graph"),
  },
  agent_send: {
    label: "send",
    starts: true,
    call: (args) => ({
      title: str(args.name),
      pairs: { mode: sendModePair(args), wait: seconds(args.wait) },
      body: str(args.message),
    }),
  },
  agent_wait: {
    label: "wait",
    running: "Send a message to stop waiting; the agents keep working.",
    call: waitCall,
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
  agent_spawn: {
    label: "spawn",
    starts: true,
    call: (args) => spawnCall(args, "group"),
  },
  agent_wait: { label: "wait", call: waitCall },
  agent_stop: {
    label: "stop",
    call: (args) => ({ title: str(args.name) }),
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

/** An agent's line: its name, then its details dim, separated by single
 * spaces. `others` counts the other agents of its graph. */
function agentRow(
  agent: AgentReceipt,
  receipt: ToolReceipt,
  color: Colorize,
  expanded = false,
  others = 0,
): string {
  const after = formatInputs(agent.inputs ?? [], others);
  const usage = agent.usage ? formatUsage(agent.usage) : "";
  const error =
    agent.outcome === "failed" && agent.body
      ? color("error", oneLine(agent.body, 120))
      : undefined;
  return [
    `${glyph(agent.outcome, receipt, color)}${agent.name}`,
    after ? color("dim", after) : undefined,
    agent.profile ? color("dim", agent.profile) : undefined,
    agent.model ? color("dim", agent.model) : undefined,
    usage ? color("dim", usage) : undefined,
    agent.job && !expanded ? color("dim", oneLine(agent.job, 120)) : undefined,
    error,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
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

/**
 * A graph's line. Below a call whose title names the graph (`titled`), it
 * leaves out the name, and a graph that only started has no line: its
 * agents hang below the call's title.
 */
function graphRow(
  graph: GraphReceipt,
  receipt: ToolReceipt,
  color: Colorize,
  titled = false,
): string | undefined {
  const total = graph.agents.length;
  if (graph.outcome === undefined)
    return titled
      ? undefined
      : `${graph.name} ${color("dim", `graph of ${total}`)}`;
  const done = graph.agents.filter((agent) => isFinished(agent.outcome)).length;
  const usage = graph.usage ? formatUsage(graph.usage) : "";
  const note = isFinished(graph.outcome) ? graphNote(graph) : undefined;
  return [
    `${glyph(graph.outcome, receipt, color)}${titled ? color("dim", `graph ${done}/${total}`) : graph.name}`,
    titled ? undefined : color("dim", `graph ${done}/${total}`),
    usage ? color("dim", usage) : undefined,
    note
      ? color(graph.outcome === "failed" ? "error" : "dim", note)
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/** A receipt's lines: graphs as trees, then agents, then how the wait
 * ended. Expanded, answers show below their agents. */
export function formatReceipt(
  receipt: ToolReceipt,
  expanded: boolean,
  color: Colorize,
  /** The call's title names its graph, as a spawn's does. */
  titled = false,
): string {
  const lines: string[] = [];
  const agentLines = (
    agent: AgentReceipt,
    lead: string,
    indent: string,
    others = 0,
  ) => {
    lines.push(
      `${color("dim", lead)}${agentRow(agent, receipt, color, expanded, others)}`,
    );
    // Expanded, a job shows in full below its agent.
    if (expanded && agent.job)
      lines.push(
        ...agent.job
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
    // A graph of one agent reads as the agent; below a call whose title
    // names it, it shows only once there's more to say than its name.
    const [only] = graph.agents;
    if (graph.agents.length === 1 && only) {
      if (!titled || only.outcome !== undefined) agentLines(only, "", "");
      continue;
    }
    const row = graphRow(graph, receipt, color, titled);
    if (row) lines.push(row);
    graph.agents.forEach((agent, index) => {
      const last = index === graph.agents.length - 1;
      agentLines(
        agent,
        last ? "└─ " : "├─ ",
        last ? "   " : "│  ",
        graph.agents.length - 1,
      );
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

/** The receipt of a stored result. */
export function decodeReceipt(details: unknown): ToolReceipt | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  return asReceipt((details as { receipt?: unknown }).receipt);
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
function toolRenderers({
  label,
  call,
  empty,
  starts,
  running,
}: ToolView): ToolRenderers {
  return {
    renderCall(args, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      return new FitLines(
        formatCall(
          label,
          call((args ?? {}) as Args),
          context.expanded,
          color,
          // Pi's own tools draw their names this way.
          (value) => theme.fg("toolTitle", theme.bold(value)),
        ),
        context.expanded,
      );
    },
    // A result indents under its call, like the call's arguments.
    renderResult(result, options, theme: Theme, context) {
      const color: Colorize = (name, value) => theme.fg(name, value);
      // An error carries no receipt: the tool threw, or Pi never ran the
      // call because the model's message broke off. Show why.
      if (context.isError)
        return new FitLines(
          indent(theme.fg("error", resultText(result) || "Failed")),
          options.expanded,
        );
      const decoded = decodeReceipt(result.details);
      // A result this version can't read shows its text.
      if (!decoded) {
        const text = resultText(result);
        return new FitLines(
          indent(
            color("dim", options.expanded ? text : (text.split("\n")[0] ?? "")),
          ),
          options.expanded,
        );
      }
      const lines = [
        formatReceipt(
          starts ? asStarted(decoded) : decoded,
          options.expanded,
          color,
          starts,
        ),
        options.isPartial && running ? color("dim", running) : "",
      ]
        .filter(Boolean)
        .join("\n");
      return new FitLines(
        indent(lines || (empty ? color("dim", empty) : "")),
        options.expanded,
      );
    },
  };
}

/** Lines indented by two columns, under a call's title. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
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
 * An agent's `agent_send` call as the message it sent, the same card as a
 * received one, and a refusal below it. `sender` names the agent.
 */
function sendView(sender: () => string): ToolRenderers & { label: string } {
  return {
    label: "send",
    renderShell: "self",
    renderCall: (args, theme: Theme, context) =>
      messageCard(
        {
          from: sender(),
          to: str((args as Args | undefined)?.name) || "?",
          text: str((args as Args | undefined)?.message),
        },
        context.expanded,
        theme,
      ),
    renderResult: (result, _options, theme: Theme, context) =>
      context.isError
        ? new Text(
            theme.fg("error", `  Not sent: ${resultText(result) || "refused"}`),
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
