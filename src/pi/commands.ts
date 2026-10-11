/**
 * Slash commands: `/agents` opens the agent overlay, `/agent <name>`
 * attaches to an agent, and `/messages` opens the threads of messages
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
  MessageInfo,
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
  formatUsage,
  graphNote,
  QUEUED_NOTE,
  runtime,
  STATE_STYLES,
  shortModel,
  shortName,
  stateIcon,
  statusIcon,
} from "../ui/format.js";
import {
  firstLine,
  MESSAGE_ICON,
  MESSAGE_STATUS_STYLES,
} from "../ui/messages.js";
import {
  type Bold,
  type DetailLine,
  type OverlaySpec,
  openOverlay,
} from "../ui/overlay.js";
import type { AgentPanel } from "../ui/panel.js";
import {
  attachTarget,
  buildRows,
  connector,
  fold,
  hiddenNote,
  type Row,
} from "../ui/rows.js";
import {
  buildThreads,
  peerOf,
  type Thread,
  threadPair,
} from "../ui/threads.js";
import type { SessionHost } from "./session.js";

/** Lines of an agent's task shown in the overlay's detail pane. */
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
  const tail = [usage, queued ? QUEUED_NOTE : ""].filter(Boolean).join("  ");
  return tail ? color("dim", tail) : "";
}

function agentRow(
  agent: AgentInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
  indent = "",
): string {
  const usage = formatUsage(agent.usage);
  const name = pad(agent.name, nameWidth - indent.length);
  return [
    `${color("dim", indent)}${statusIcon(agent, color)} ${isVisible(agent) ? name : color("dim", name)}`,
    color("dim", pad(agent.profile ?? "ad-hoc", 10)),
    color("dim", pad(shortModel(agent), 14)),
    color("dim", pad(formatElapsed(runtime(agent, now)), 7)),
    rowTail(usage, agent.queued, color),
  ].join("  ");
}

function graphRow(
  graph: GraphInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
  indent = "",
): string {
  const usage = formatUsage(graph.usage);
  const name = pad(graph.name, nameWidth - indent.length);
  return [
    `${color("dim", indent)}${statusIcon(graph, color)} ${isGraphVisible(graph) ? name : color("dim", name)}`,
    color("dim", pad(graph.owner ? "helpers" : "graph", 10)),
    color("dim", pad(`${graph.nodes.length} agents`, 14)),
    color("dim", pad(formatElapsed(runtime(graph, now)), 7)),
    rowTail(usage, graph.queued, color),
  ].join("  ");
}

/** The glyph state of a graph's agent: how its task ended, else its
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
      .join(" · ");
    const word =
      outcome?.kind === "stopped" || outcome?.kind === "interrupted"
        ? outcome.kind
        : undefined;
    if (index > 0) lines.push("");
    lines.push(
      [
        `${stateIcon(nodeState(outcome, agent), color)} ${bold(name)}`,
        inputs.length > 0 ? color("dim", ` ← ${inputs.join(", ")}`) : "",
        meta ? color("dim", ` · ${meta}`) : "",
        word ? color("dim", ` · ${word}`) : "",
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
            `… ${hidden} more lines · select ${name} to read all`,
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

/** The divider over an agent's task: `Task · name · started … · cwd`. */
export function agentHeader(
  agent: AgentInfo,
  color: Colorize,
  now: number = Date.now(),
): string {
  return `${color("accent", "Task")}${color(
    "dim",
    ` · ${agent.name} · started ${formatElapsed(now - agent.createdAt)} ago · ${tildePath(agent.cwd)}`,
  )}`;
}

/**
 * An agent's detail below its task's divider: the task, then a divider and
 * its latest result, both as Markdown, or its error. The divider says
 * "Result" while that result answers the task, and "Latest result" once the
 * agent answered later messages.
 */
export function agentDetail(
  agent: AgentInfo,
  color: Colorize,
  now: number = Date.now(),
  /** The agent's threads, when messaging is on. */
  threads: readonly Thread[] = [],
): DetailLine[] {
  const lines: DetailLine[] = [
    {
      markdown: agent.task,
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
        : color("dim", ` · ${formatElapsed(now - result.at)} ago`);
    const label =
      result.entryId === agent.taskAnswer ? "Result" : "Latest result";
    const queued = agent.queued ? color("dim", ` · ${QUEUED_NOTE}`) : "";
    lines.push(
      { divider: `${color("accent", label)}${when}${queued}` },
      {
        markdown: result.text,
        maxLines: DETAIL_RESULT_LINES,
        more: (hidden) => `… ${hidden} more lines (attach to read)`,
      },
    );
  }
  if (threads.length > 0) {
    lines.push({
      divider: `${color("accent", "Messages")}${color("dim", " · m to read")}`,
    });
    for (const thread of threads) {
      const last = thread.messages.at(-1);
      const peer = peerOf(thread, agent.id).name;
      lines.push(
        `⇄ ${peer}${color(
          "dim",
          ` · ${count(thread.messages.length, "message")}${last ? ` · ${firstLine(last.text)}` : ""}`,
        )}`,
      );
    }
  }
  return lines;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A message in a thread: who sent it to whom, its status, how long ago,
 * and its text. */
export function messageDetail(
  message: MessageInfo,
  color: Colorize,
  bold: Bold,
  now: number = Date.now(),
): DetailLine[] {
  const status = MESSAGE_STATUS_STYLES[message.status];
  return [
    `${color("dim", MESSAGE_ICON)} ${bold(message.from.name)}${color("dim", " → ")}${bold(message.to.name)}${color("dim", " · ")}${color(status.color, status.icon)}${color("dim", ` · ${formatElapsed(now - message.sentAt)} ago`)}`,
    { markdown: message.text, indent: 2 },
  ];
}

/**
 * `/messages`: threads on top, latest first, and the selected thread's
 * messages below, oldest first. ⏎ attaches to one of the thread's agents,
 * Tab opens `/agents`.
 */
async function openMessagesOverlay(
  ctx: ExtensionContext,
  deps: CommandDeps,
  options: { thread?: string; agent?: string } = {},
): Promise<void> {
  const service = await deps.host.ensure(ctx);
  const agentName = options.agent
    ? service.agentById(options.agent)?.name
    : undefined;
  let after: (() => void) | undefined;
  const items = () => buildThreads(service.messages(), options.agent);
  const spec: OverlaySpec<Thread> = {
    title: agentName ? `Messages · ${agentName}` : "Messages",
    emptyText: deps.host.messaging()
      ? "No messages between agents yet."
      : "Messaging between agents is off. Set piAgents.messaging to turn it on.",
    footer: "↑↓ thread · ⏎ attach · tab /agents · esc",
    ...(options.thread ? { initialKey: options.thread } : {}),
    items,
    keyOf: (thread) => thread.key,
    row: (thread, color) => {
      const width = Math.max(
        ...items().map((each) => threadPair(each, options.agent).length),
        4,
      );
      const last = thread.messages.at(-1);
      const queued = thread.messages.some(
        (message) => message.status === "queued",
      );
      const style = MESSAGE_STATUS_STYLES.queued;
      return [
        pad(threadPair(thread, options.agent), width),
        color(
          "dim",
          `${count(thread.messages.length, "message")}${last ? ` · last ${formatElapsed(Date.now() - last.sentAt)} ago` : ""}`,
        ),
        queued ? color(style.color, style.icon) : "",
      ]
        .filter(Boolean)
        .join("  ");
    },
    headerLine: (thread, color) =>
      color(
        "dim",
        `${threadPair(thread, options.agent)} · ${count(thread.messages.length, "message")}`,
      ),
    detail: (thread, color, bold) => {
      const dropped = service.droppedMessages();
      const lines: DetailLine[] =
        dropped > 0
          ? [
              color(
                "dim",
                `This session no longer keeps its ${count(dropped, "oldest message")}.`,
              ),
              "",
            ]
          : [];
      thread.messages.forEach((message, index) => {
        if (index > 0) lines.push("");
        lines.push(...messageDetail(message, color, bold));
      });
      return lines;
    },
    onAction: (key, thread) => {
      if (key === "tab") {
        after = () =>
          void openAgentsOverlay(ctx, deps).catch((error) =>
            ctx.ui.notify(errorText(error), "error"),
          );
        return "close";
      }
      if (key === "enter") {
        const [first, second] = thread.agents;
        after = () =>
          void ctx.ui
            .select("Attach to", [first.name, second.name])
            .then((name) => {
              const agent = name === second.name ? second : first;
              if (name) deps.focus.attach(ctx, agent.id);
            });
        return "close";
      }
      return undefined;
    },
    live: () =>
      service.messages().some((message) => message.status === "queued") ||
      service.list().some((agent) => agent.state === "working"),
  };
  await openOverlay(ctx, spec, deps.panel);
  after?.();
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
    // Tab returns to the panel only while it shows agents.
    footer: () =>
      `↑↓ move · space fold · ⏎ attach · s stop${deps.host.messaging() ? " · m messages" : ""}${deps.panel.hasRows() ? " · tab panel" : ""} · esc`,
    ...(select ? { initialKey: select } : {}),
    items,
    keyOf: (row) => row.key,
    row: (row, color) => {
      const width = Math.max(...items().map((item) => rowName(item).length), 4);
      const line =
        row.kind === "graph"
          ? graphRow(
              { ...row.graph, name: row.label },
              Date.now(),
              width,
              color,
              connector(row),
            )
          : agentRow(
              { ...row.agent, name: row.label },
              Date.now(),
              width,
              color,
              connector(row),
            );
      const hidden = hiddenNote(row);
      return hidden ? `${line}  ${color("dim", hidden)}` : line;
    },
    headerLine: (row, color) => {
      if (row.kind === "agent") return agentHeader(row.agent, color);
      const graph = row.graph;
      const note = graphNote(graph);
      return color(
        "dim",
        [
          `${graph.name} · graph of ${graph.nodes.length}`,
          graph.policy === "failFast" ? "stops on failure" : "waits for all",
          ...(note ? [note] : []),
          `started ${formatElapsed(Date.now() - graph.createdAt)} ago`,
        ].join(" · "),
      );
    },
    detail: (row, color, bold) =>
      row.kind === "agent"
        ? agentDetail(
            row.agent,
            color,
            Date.now(),
            deps.host.messaging()
              ? buildThreads(service.messages(), row.agent.id)
              : [],
          )
        : graphDetail(row.graph, (id) => service.agentById(id), color, bold),
    onAction: (key, row) => {
      if (key === "space") return { select: fold(row, deps.panel.disclosure) };
      if (key === "m" && deps.host.messaging()) {
        const agent = row.kind === "agent" ? row.agent.id : undefined;
        after = () =>
          void openMessagesOverlay(ctx, deps, agent ? { agent } : {}).catch(
            (error) => ctx.ui.notify(errorText(error), "error"),
          );
        return "close";
      }
      if (key === "tab") {
        if (!deps.panel.hasRows()) return undefined;
        after = () => deps.focus.focusPanelAt(ctx, row.key);
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
            .catch((error) => ctx.ui.notify(errorText(error), "error"));
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

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  deps.focus.onBrowse = (ctx, select) =>
    void openAgentsOverlay(ctx, deps, select).catch((error) =>
      ctx.ui.notify(errorText(error), "error"),
    );
  deps.focus.onThread = (ctx, thread) =>
    void openMessagesOverlay(ctx, deps, { thread }).catch((error) =>
      ctx.ui.notify(errorText(error), "error"),
    );

  pi.registerCommand("messages", {
    description: "Read the messages agents sent each other",
    handler: async (_args, ctx) => {
      try {
        await openMessagesOverlay(ctx, deps);
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description: "Browse agents: attach to or stop them",
    handler: async (_args, ctx) => {
      try {
        await openAgentsOverlay(ctx, deps);
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
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
            description: `${STATE_STYLES[agent.state].icon} ${agent.task.replace(/\s+/g, " ").slice(0, 60)}`,
          }));
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        await openAgentsOverlay(ctx, deps).catch((error) =>
          ctx.ui.notify(errorText(error), "error"),
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
