/**
 * Slash commands: `/agents` opens the agent overlay, `/agent <name>`
 * attaches to an agent, and `/messages` opens the stream of messages
 * between agents.
 */

import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isGraphVisible, isVisible } from "../agents/service.js";
import { orderSentence } from "../agents/topology.js";
import type {
  AgentInfo,
  AgentState,
  GraphInfo,
  NodeOutcome,
} from "../agents/types.js";
import {
  confirmAndStop,
  errorText,
  type FocusController,
  stopTarget,
} from "../ui/focus.js";
import {
  type Colorize,
  formatElapsed,
  formatInputs,
  formatUsage,
  graphNote,
  QUEUED_NOTE,
  runtime,
  STATUS_STYLES,
  shortModel,
  shortName,
  stateIcon,
  statusIcon,
  statusOf,
} from "../ui/format.js";
import type { Bold, DetailLine } from "../ui/frame.js";
import { type OverlaySpec, openOverlay } from "../ui/overlay.js";
import type { AgentPanel } from "../ui/panel.js";
import {
  attachTarget,
  buildRows,
  connector,
  fold,
  hiddenNote,
  type Row,
} from "../ui/rows.js";
import { openMessageStream } from "../ui/stream.js";
import { notify } from "./notify.js";
import type { SessionHost } from "./session.js";

/** Lines of an agent's job shown in the overlay's detail pane. */
const DETAIL_TASK_LINES = 20;
/** Lines of the latest result shown in the overlay's detail pane. */
const DETAIL_RESULT_LINES = 200;
/** Lines of each agent's result in a graph's detail pane. */
const DETAIL_NODE_LINES = 8;

export interface CommandDeps {
  host: SessionHost;
  panel: AgentPanel;
  focus: FocusController;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/** A row's last column: usage, then whether its result is queued. */
function rowTail(
  usage: string,
  queued: boolean | undefined,
  color: Colorize,
): string {
  const tail = [usage, queued ? QUEUED_NOTE : ""].filter(Boolean).join(" ");
  return tail ? color("dim", tail) : "";
}

/** A name in bold, the row's primary information, padded to `width`. */
function boldName(name: string, width: number, bold: Bold): string {
  return `${bold(name)}${" ".repeat(Math.max(0, width - name.length))}`;
}

/** An agent's row: its name in bold, the rest dim. */
function agentRow(
  agent: AgentInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
  bold: Bold,
  indent = "",
): string {
  const usage = formatUsage(agent.usage);
  const name = boldName(agent.name, nameWidth - indent.length, bold);
  return [
    `${color("dim", indent)}${statusIcon(agent, color)} ${name}`,
    color("dim", pad(agent.profile ?? "ad-hoc", 10)),
    color("dim", pad(shortModel(agent), 14)),
    color("dim", pad(formatElapsed(runtime(agent, now)), 7)),
    rowTail(usage, agent.queued, color),
  ].join(" ");
}

/** A graph's row: its name in bold, the rest dim. */
function graphRow(
  graph: GraphInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
  bold: Bold,
  indent = "",
): string {
  const usage = formatUsage(graph.usage);
  const name = boldName(graph.name, nameWidth - indent.length, bold);
  return [
    `${color("dim", indent)}${statusIcon(graph, color)} ${name}`,
    color("dim", pad(graph.owner ? "helpers" : "graph", 10)),
    color("dim", pad(`${graph.nodes.length} agents`, 14)),
    color("dim", pad(formatElapsed(runtime(graph, now)), 7)),
    rowTail(usage, graph.queued, color),
  ].join(" ");
}

/** The glyph state of a graph's agent: how its job ended, else its
 * current state. */
function nodeState(
  outcome: NodeOutcome | undefined,
  agent: AgentInfo | undefined,
): AgentState {
  if (!outcome) return agent?.state ?? "working";
  switch (outcome.kind) {
    case "answered":
      return outcome.result.stopReason === "error" ? "failed" : "idle";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "interrupted";
  }
}

/**
 * A graph's detail: its shape when it has edges, then one block per agent:
 * a heading with its glyph, name, and spend, and its result as Markdown.
 * The glyph says how the agent did; only ⊘, which means both stopped and
 * interrupted, gets a word.
 */
export function graphDetail(
  graph: GraphInfo,
  lookup: (id: string) => AgentInfo | undefined,
  color: Colorize,
  bold: Bold = (text) => text,
): DetailLine[] {
  // Helpers repeat their agent's name, which the divider above shows.
  const owner = graph.owner ? lookup(graph.owner)?.name : undefined;
  const names = new Map(
    graph.nodes.map((node) => [node.agentId, shortName(node.name, owner)]),
  );
  const lines: DetailLine[] = [];
  const order = orderSentence(
    graph.nodes.map((node) => ({ key: node.agentId, inputs: node.inputs })),
    (key) => names.get(key) ?? key,
  );
  if (order) lines.push(color("dim", order), "");
  if (graph.queued)
    lines.push(color("dim", "The result waits until Pi's turn ends."), "");
  graph.nodes.forEach((node, index) => {
    const agent = lookup(node.agentId);
    const outcome = node.outcome;
    const name = names.get(node.agentId) ?? node.name;
    const inputs = node.inputs.map((input) => names.get(input) ?? input);
    const usage = agent ? formatUsage(agent.usage) : "";
    const meta = [agent ? shortModel(agent) : undefined, usage || undefined]
      .filter(Boolean)
      .join(" ");
    const after = formatInputs(inputs, graph.nodes.length - 1);
    const word =
      outcome?.kind === "stopped" || outcome?.kind === "interrupted"
        ? outcome.kind
        : undefined;
    if (index > 0) lines.push("");
    lines.push(
      [
        `${stateIcon(nodeState(outcome, agent), color)} ${bold(name)}`,
        after ? color("dim", ` ${after}`) : "",
        meta ? color("dim", ` ${meta}`) : "",
        word ? color("dim", ` ${word}`) : "",
      ].join(""),
    );
    if (outcome?.kind === "answered") {
      const result = outcome.result;
      if (result.stopReason === "error")
        lines.push(
          color(
            "error",
            `  ${result.errorMessage ?? (result.text || "error")}`,
          ),
        );
      else if (result.text)
        lines.push({
          markdown: result.text,
          indent: 2,
          maxLines: DETAIL_NODE_LINES,
          more: (hidden) =>
            `… ${hidden} more lines (select ${name} to read all)`,
        });
    } else if (outcome?.kind === "failed") {
      lines.push(color("error", `  ${outcome.reason}`));
    }
  });
  return lines;
}

function rowName(row: Row): string {
  return `${connector(row)}${row.label}`;
}

/** `~/…` for paths in the home directory. */
function tildePath(path: string): string {
  const home = os.homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

/** The divider over an agent's job: `Job name started … ago in cwd`. */
export function agentHeader(
  agent: AgentInfo,
  color: Colorize,
  now: number = Date.now(),
): string {
  return `${color("accent", "Job")} ${agent.name}${color(
    "dim",
    ` started ${formatElapsed(now - agent.createdAt)} ago in ${tildePath(agent.cwd)}`,
  )}`;
}

/**
 * An agent's detail below its job's divider: the job, then a divider and
 * its latest result, both as Markdown, or its error. The divider says
 * "Result" while that result answers the job, and "Latest result" once the
 * agent answered later messages.
 */
export function agentDetail(
  agent: AgentInfo,
  color: Colorize,
  now: number = Date.now(),
): DetailLine[] {
  const lines: DetailLine[] = [
    {
      markdown: agent.job,
      maxLines: DETAIL_TASK_LINES,
      more: (hidden) => `… ${hidden} more lines (attach to read)`,
    },
  ];
  const result = agent.result;
  if (agent.state === "failed") {
    lines.push(
      { divider: color("error", "Error") },
      color("error", result?.errorMessage ?? "The last answer failed."),
    );
  } else if (result?.text) {
    const when =
      result.at === undefined
        ? ""
        : color("dim", ` ${formatElapsed(now - result.at)} ago`);
    const label =
      result.entryId === agent.jobAnswer ? "Result" : "Latest result";
    const queued = agent.queued ? color("dim", `, ${QUEUED_NOTE}`) : "";
    lines.push(
      { divider: `${color("accent", label)}${when}${queued}` },
      {
        markdown: result.text,
        maxLines: DETAIL_RESULT_LINES,
        more: (hidden) => `… ${hidden} more lines (attach to read)`,
      },
    );
  }
  return lines;
}

/**
 * `/messages`: every message between agents, newest first (see
 * `src/ui/stream.ts`). With `agent`, it starts filtered by that agent's
 * name; with `message`, at that message.
 */
async function openMessagesOverlay(
  ctx: ExtensionContext,
  deps: CommandDeps,
  options: { message?: string; agent?: string } = {},
): Promise<void> {
  const service = await deps.host.ensure(ctx);
  const agentName = options.agent
    ? service.agentById(options.agent)?.name
    : undefined;
  const fail = (error: unknown) => notify(ctx, errorText(error), "error");
  const agents = () => void openAgentsOverlay(ctx, deps).catch(fail);
  await openMessageStream(
    ctx,
    {
      messages: () => service.messages(),
      ...(agentName ? { query: agentName } : {}),
      ...(options.message ? { select: options.message } : {}),
      emptyText: "No messages between agents yet.",
      attach: (agentId) => deps.focus.attach(ctx, agentId),
      next: deps.panel.hasRows()
        ? { label: "panel", open: () => deps.focus.focusPanel(ctx) }
        : { label: "/agents", open: agents },
      previous: { label: "/agents", open: agents },
      live: () =>
        service.messages().some((message) => message.status === "queued") ||
        service.list().some((agent) => agent.state === "working"),
    },
    deps.panel,
  );
}

async function openAgentsOverlay(
  ctx: ExtensionContext,
  deps: CommandDeps,
  /** The row to select first, by key, such as the panel's selection. */
  select?: string,
): Promise<void> {
  const service = await deps.host.ensure(ctx);
  let after: (() => void) | undefined;
  // Graphs and agents, open ones first, then closed ones, newest first; a
  // graph's agents follow it.
  const items = () =>
    buildRows(
      {
        agents: service.list({ includeClosed: true }),
        graphs: service.graphs({ includeClosed: true }),
        agent: (id) => service.agentById(id),
      },
      (left, right) =>
        Number(!right.closed || right.state === "working") -
          Number(!left.closed || left.state === "working") ||
        right.createdAt - left.createdAt,
      () => true,
      deps.panel.disclosure,
    );
  const spec: OverlaySpec<Row> = {
    title: "Agents",
    emptyText: "No agents yet. Ask Pi to delegate.",
    footer: () => [
      "↑↓ move",
      "space fold",
      "⏎ attach",
      "s stop",
      "m messages",
      "tab /messages",
      "esc back",
    ],
    ...(select ? { initialKey: select } : {}),
    items,
    keyOf: (row) => row.key,
    row: (row, color, bold) => {
      const width = Math.max(...items().map((item) => rowName(item).length), 4);
      const line =
        row.kind === "graph"
          ? graphRow(
              { ...row.graph, name: row.label },
              Date.now(),
              width,
              color,
              bold,
              connector(row),
            )
          : agentRow(
              { ...row.agent, name: row.label },
              Date.now(),
              width,
              color,
              bold,
              connector(row),
            );
      const hidden = hiddenNote(row);
      return hidden ? `${line} ${color("dim", hidden)}` : line;
    },
    headerLine: (row, color) => {
      if (row.kind === "agent") return agentHeader(row.agent, color);
      const graph = row.graph;
      const note = graphNote(graph);
      return `${graph.name}${color(
        "dim",
        ` ${[
          `graph of ${graph.nodes.length}`,
          graph.policy === "failFast" ? "stops on failure" : "waits for all",
          ...(note ? [note] : []),
          `started ${formatElapsed(Date.now() - graph.createdAt)} ago`,
        ].join(", ")}`,
      )}`;
    },
    detail: (row, color, bold) =>
      row.kind === "agent"
        ? agentDetail(row.agent, color)
        : graphDetail(row.graph, (id) => service.agentById(id), color, bold),
    // Tab goes on to /messages, Shift+Tab back to the panel, or to
    // /messages while the panel has nothing to show.
    onNavigate: (key, row) => {
      if (key === "shift+tab" && deps.panel.hasRows()) {
        after = () =>
          row
            ? deps.focus.focusPanelAt(ctx, row.key)
            : deps.focus.focusPanel(ctx);
        return "close";
      }
      after = () =>
        void openMessagesOverlay(ctx, deps).catch((error) =>
          notify(ctx, errorText(error), "error"),
        );
      return "close";
    },
    onAction: (key, row) => {
      if (key === "space") return { select: fold(row, deps.panel.disclosure) };
      if (key === "m") {
        const agent = row.kind === "agent" ? row.agent.id : undefined;
        after = () =>
          void openMessagesOverlay(ctx, deps, agent ? { agent } : {}).catch(
            (error) => notify(ctx, errorText(error), "error"),
          );
        return "close";
      }
      if (key === "enter") {
        const agentId = attachTarget(row);
        if (!agentId) return undefined;
        after = () => deps.focus.attach(ctx, agentId);
        return "close";
      }
      if (key === "s") {
        const target = stopTarget(row);
        const visible =
          row.kind === "agent"
            ? isVisible(row.agent)
            : isGraphVisible(row.graph);
        if (!visible) return undefined;
        if (target.state !== "working") {
          void service
            .stop(target.id)
            .catch((error) => notify(ctx, errorText(error), "error"));
          return undefined;
        }
        after = () => void confirmAndStop(ctx, deps.host, target);
        return "close";
      }
      return undefined;
    },
    live: () =>
      items().some(
        (row) =>
          (row.kind === "agent" ? row.agent.state : row.graph.state) ===
          "working",
      ),
  };
  await openOverlay(ctx, spec, deps.panel);
  after?.();
}

/** Whether the views can open: they need Pi's terminal UI, which RPC
 * clients don't render. Says so where it can. */
function inTerminal(ctx: ExtensionContext, command: string): boolean {
  if (ctx.mode === "tui") return true;
  if (ctx.hasUI) ctx.ui.notify(`${command} needs Pi's terminal UI.`, "warning");
  return false;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  deps.focus.onBrowse = (ctx, select) =>
    void openAgentsOverlay(ctx, deps, select).catch((error) =>
      notify(ctx, errorText(error), "error"),
    );
  deps.focus.onMessages = (ctx, options) =>
    void openMessagesOverlay(ctx, deps, options).catch((error) =>
      notify(ctx, errorText(error), "error"),
    );

  pi.registerCommand("messages", {
    description: "Read the messages agents sent each other",
    handler: async (_args, ctx) => {
      if (!inTerminal(ctx, "/messages")) return;
      try {
        await openMessagesOverlay(ctx, deps);
      } catch (error) {
        notify(ctx, errorText(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description: "Browse agents: attach to or stop them",
    handler: async (_args, ctx) => {
      if (!inTerminal(ctx, "/agents")) return;
      try {
        await openAgentsOverlay(ctx, deps);
      } catch (error) {
        notify(ctx, errorText(error), "error");
      }
    },
  });

  pi.registerCommand("agent", {
    description: "Attach to an agent",
    getArgumentCompletions: (prefix) => {
      const service = deps.host.current();
      const names = new Set(
        (service?.list({ includeClosed: true }) ?? []).map(
          (agent) => agent.name,
        ),
      );
      const matches = [...names]
        .filter((name) => name.startsWith(prefix))
        .flatMap((name) => service?.get(name) ?? []);
      return matches.length === 0
        ? null
        : matches.map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: `${STATUS_STYLES[statusOf(agent)].icon} ${agent.job.replace(/\s+/g, " ").slice(0, 60)}`,
          }));
    },
    handler: async (args, ctx) => {
      if (!inTerminal(ctx, "/agent")) return;
      const name = args.trim();
      if (!name) {
        await openAgentsOverlay(ctx, deps).catch((error) =>
          notify(ctx, errorText(error), "error"),
        );
        return;
      }
      const agent = deps.host.current()?.get(name);
      if (!agent) {
        ctx.ui.notify(`No agent named ${name}.`, "warning");
        return;
      }
      deps.focus.attach(ctx, agent.id);
    },
  });
}
