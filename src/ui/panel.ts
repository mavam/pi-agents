/**
 * AgentPanel: one line per open agent or graph above the editor, a graph's
 * agents below it as a tree.
 *
 *   ◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep
 *   ◉ review · graph 1/3 · 40s · 12.0k
 *   ├─ ● api · terra · 4.0k
 *   ├─ ◉ tests · sol · 40s · 8.0k · Using grep
 *   └─ ○ merge ← api, tests · opus
 *
 * Unfocused, it shows the first few lines, working ones first, and a
 * finished graph as one line. Left arrow from an empty editor or Ctrl+Q
 * focuses it (see focus.ts); then ↑↓ select, space folds a graph or an
 * agent's helpers, ⏎ attaches (a graph: its first agent), `s` stops, Tab
 * opens `/agents` at the selected row, and Esc returns to the editor.
 *
 * With messaging on, the latest messages of the agents shown follow the
 * agents, stacked below them or in a column to their right:
 *
 *   ◉ scout · sol · 40s · 8.1k  │ □ scout → notes  bun.lock is 412 KB   ✔
 *   ● notes · terra · 2.0k      │ □ scout → notes  README.md is 18 KB   ◷
 *
 * ↑↓ continue from the agents into the messages, ⏎ on a message opens its
 * thread in `/messages`, `m` shows or hides messages, and `v` switches the
 * view. A dim line counts earlier messages the panel leaves out.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentInfo, MessageInfo } from "../agents/types.js";
import type { SessionHost } from "../pi/session.js";
import { formatAgentLine, formatGraphLine, sanitizeLine } from "./format.js";
import {
  formatMessageLine,
  type MessageStyle,
  messageParts,
  pairWidth,
  themeStyle,
} from "./messages.js";
import {
  attachTarget,
  buildRows,
  connector,
  Disclosure,
  type EntryOrder,
  fold,
  hiddenNote,
  type Row,
} from "./rows.js";

const WIDGET_KEY = "pi-agents:panel";
const MAX_UNFOCUSED = 6;
const TICK_MS = 1000;
/** A reasoning headline stays at least this long before the next replaces it. */
const SUMMARY_MIN_DISPLAY_MS = 3000;
/** Focused-panel height cap, as a fraction of the terminal. */
const MAX_HEIGHT_RATIO = 0.6;
/** Messages stacked below the agents, unfocused and focused. */
const STACKED_MESSAGES = 3;
const STACKED_MESSAGES_FOCUSED = 6;
/** Below this width, columns stack. */
export const COLUMNS_MIN_WIDTH = 120;
/** The fewest rows the message column shows, when there are messages. */
const COLUMN_MIN_HEIGHT = 3;
/** The widest message line, so its status stays near its text. */
const MAX_MESSAGE_WIDTH = 100;
/** The agent column's widest share of the panel. */
const AGENT_COLUMN_RATIO = 0.45;

export type MessageView = "stacked" | "columns";

function messageKey(message: MessageInfo): string {
  return `message:${message.id}`;
}

function padLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "…");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

const STATE_ORDER = {
  working: 0,
  waiting: 0,
  failed: 1,
  interrupted: 2,
  skipped: 3,
  idle: 3,
} as const;

/** Panel order: working first, then newest first. */
export const panelCompare: EntryOrder = (left, right) =>
  STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
  right.createdAt - left.createdAt;

/** Open agents in panel order. */
export function panelOrder(agents: readonly AgentInfo[]): AgentInfo[] {
  return [...agents].sort(panelCompare);
}

class PanelLines implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  invalidate(): void {
    // Content is a pure function of panel state.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.build(usable).map(
      (line) => ` ${truncateToWidth(sanitizeLine(line), usable, "…")}`,
    );
  }
}

interface HeldSummary {
  text: string;
  shownAt: number;
}

export class AgentPanel {
  private lastContext: ExtensionContext | undefined;
  private lastTui: TUI | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private mounted = false;
  private disposed = false;
  private suppressed = false;
  private focused = false;
  private selectedKey: string | undefined;
  /** What the user folded; `/agents` shares it. */
  readonly disclosure = new Disclosure();
  private readonly held = new Map<string, HeldSummary>();
  private messagesShown = true;
  private view: MessageView = "columns";
  /** The messages the latest focused frame showed, which ↑↓ reach. */
  private shownMessages: MessageInfo[] = [];

  constructor(
    private readonly host: SessionHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rows in panel order; `collapse` folds finished graphs to one line. */
  rows(collapse = false): Row[] {
    const service = this.host.current();
    if (!service) return [];
    return buildRows(
      {
        agents: service.list(),
        graphs: service.graphs(),
        agent: (id) => service.agentById(id),
      },
      panelCompare,
      (graph) => !collapse || graph.state === "working",
      this.disclosure,
    );
  }

  /** Messages of the agents the panel shows, oldest first; none while
   * messaging is off or hidden. */
  messages(): MessageInfo[] {
    const service = this.host.current();
    if (!service || !this.host.messaging() || !this.messagesShown) return [];
    const shown = new Set(service.list().map((info) => info.id));
    return service
      .messages()
      .filter(
        (message) => shown.has(message.from.id) || shown.has(message.to.id),
      );
  }

  /** `m`: show or hide messages. */
  toggleMessages(): void {
    this.messagesShown = !this.messagesShown;
    if (!this.messagesShown) this.shownMessages = [];
    this.update();
  }

  /** `v`: switch between stacked and columns. */
  toggleView(): void {
    this.view = this.view === "columns" ? "stacked" : "columns";
    this.update();
  }

  /** Select a row by key, if the panel shows it. */
  select(key: string | undefined): void {
    if (key !== undefined && this.rows().some((row) => row.key === key))
      this.selectedKey = key;
  }

  /** Space: fold or unfold the selected row, or the row it sits below. */
  toggle(): void {
    const row = this.selected();
    if (!row) return;
    this.selectedKey = fold(row, this.disclosure);
    this.update();
  }

  update(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    const context = ctx ?? this.lastContext;
    if (context?.mode !== "tui") return;
    this.lastContext = context;
    if (!this.shouldShow()) {
      this.stopTicking();
      this.focused = false;
    } else {
      this.startTicking();
    }
    if (!this.mounted) {
      // One persistent component that pulls live state per render; remounting
      // per update desynchronizes Pi's differential renderer. Keep the empty
      // widget mounted too, so keyboard guards always have the current TUI.
      context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.lastTui = tui;
        return new PanelLines((width) => this.frame(tui, theme, width));
      });
      this.mounted = true;
      return;
    }
    this.lastTui?.requestRender?.();
  }

  private shouldShow(): boolean {
    return !this.suppressed && this.hasRows();
  }

  /** Hide the panel while a view in the editor slot shows the same agents. */
  setSuppressed(value: boolean): void {
    if (this.suppressed === value) return;
    this.suppressed = value;
    this.update();
  }

  /** Whether a view in the editor slot hides the panel. */
  isSuppressed(): boolean {
    return this.suppressed;
  }

  /**
   * Whether the terminal has a visible overlay, including other extensions'.
   */
  hasOverlay(): boolean {
    return this.lastTui?.hasOverlay() ?? false;
  }

  hasRows(): boolean {
    return this.rows().length > 0;
  }

  isFocused(): boolean {
    return this.focused;
  }

  setFocused(value: boolean): void {
    if (this.focused === value) return;
    this.focused = value;
    if (value) this.selected();
    this.update();
  }

  /** The selected row, normalizing a stale selection to the first row;
   * nothing while a message is selected. */
  selected(): Row | undefined {
    const rows = this.rows();
    const current = rows.find((row) => row.key === this.selectedKey);
    if (current) return current;
    if (this.selectedMessage()) return undefined;
    this.selectedKey = rows[0]?.key;
    return rows[0];
  }

  /** The selected message, if a message is selected. */
  selectedMessage(): MessageInfo | undefined {
    return this.shownMessages.find(
      (message) => messageKey(message) === this.selectedKey,
    );
  }

  /** The agent ⏎ attaches to: the selected row's, or a message's
   * recipient. */
  attachTarget(): string | undefined {
    const message = this.selectedMessage();
    if (message) return message.to.id;
    const row = this.selected();
    return row ? attachTarget(row) : undefined;
  }

  /** Move the selection through the rows, then the messages; returns
   * false when moving above the first row. */
  move(delta: number): boolean {
    const keys = [
      ...this.rows().map((row) => row.key),
      ...this.shownMessages.map(messageKey),
    ];
    if (!this.selectedMessage()) this.selected();
    const index = keys.indexOf(this.selectedKey ?? "");
    if (index < 0) return false;
    const next = index + delta;
    if (next < 0) return false;
    if (next >= keys.length) return true;
    this.selectedKey = keys[next];
    this.update();
    return true;
  }

  /** Hold a reasoning headline briefly so fast updates stay readable. */
  private heldActivity(info: AgentInfo, now: number): AgentInfo {
    const summary = info.activity.summary;
    if (info.state !== "working" || summary === undefined) {
      this.held.delete(info.id);
      return info;
    }
    const held = this.held.get(info.id);
    if (!held || held.text === summary) {
      if (!held) this.held.set(info.id, { text: summary, shownAt: now });
      return info;
    }
    if (now - held.shownAt >= SUMMARY_MIN_DISPLAY_MS) {
      this.held.set(info.id, { text: summary, shownAt: now });
      return info;
    }
    return { ...info, activity: { ...info.activity, summary: held.text } };
  }

  private lines(budget: number, style: MessageStyle, width: number): string[] {
    const { color } = style;
    const now = this.now();
    const messages = this.messages();
    const columns = this.view === "columns" && width >= COLUMNS_MIN_WIDTH;
    const line = (row: Row) => {
      const text =
        row.kind === "graph"
          ? formatGraphLine({ ...row.graph, name: row.label }, now, color)
          : formatAgentLine(
              { ...this.heldActivity(row.agent, now), name: row.label },
              now,
              color,
              row.inputs,
            );
      const hidden = hiddenNote(row);
      return `${color("dim", connector(row))}${text}${hidden ? color("dim", ` · ${hidden}`) : ""}`;
    };
    if (!this.focused) {
      const rows = this.rows(true);
      const shown = rows.slice(0, MAX_UNFOCUSED).map(line);
      if (rows.length > MAX_UNFOCUSED)
        shown.push(
          color("dim", `+${rows.length - MAX_UNFOCUSED} more (/agents)`),
        );
      this.shownMessages = [];
      return this.withMessages(shown, messages, {
        width,
        style,
        columns,
        stacked: STACKED_MESSAGES,
      });
    }
    const rows = this.rows();
    const selected = this.selected();
    const index = selected
      ? Math.max(
          0,
          rows.findIndex((row) => row.key === selected.key),
        )
      : -1;
    const below =
      !columns && messages.length > 0
        ? 1 + Math.min(messages.length, STACKED_MESSAGES_FOCUSED)
        : 0;
    const visible = Math.max(3, budget - 1 - below);
    const start = Math.max(
      0,
      Math.min(
        (index < 0 ? rows.length : index) - Math.floor(visible / 2),
        rows.length - visible,
      ),
    );
    const agentLines = rows
      .slice(start, start + visible)
      .map(
        (row, offset) =>
          `${start + offset === index ? color("accent", "▸ ") : "  "}${line(row)}`,
      );
    if (rows.length > start + visible)
      agentLines.push(
        color("dim", `  …+${rows.length - start - visible} more`),
      );
    const lines = this.withMessages(agentLines, messages, {
      width,
      style,
      columns,
      stacked: STACKED_MESSAGES_FOCUSED,
      selectable: true,
    });
    const message = this.selectedMessage();
    const hints = [
      "↑↓ move",
      ...(message ? ["⏎ thread"] : ["space fold", "⏎ attach", "s stop"]),
      ...(this.host.messaging()
        ? [
            "m messages",
            this.view === "columns"
              ? `v stack${columns ? "" : " (columns need 120 cols)"}`
              : "v columns",
          ]
        : []),
      "tab /agents",
      "esc editor",
    ];
    lines.push(color("dim", `  ${hints.join(" · ")}`));
    return lines;
  }

  /**
   * Agent lines with the latest messages below them, stacked, or to their
   * right, in a column as tall as theirs. `selectable` makes the shown
   * messages reachable with ↑↓ and marks the selected one.
   */
  private withMessages(
    left: string[],
    messages: readonly MessageInfo[],
    options: {
      width: number;
      style: MessageStyle;
      columns: boolean;
      stacked: number;
      selectable?: boolean;
    },
  ): string[] {
    const { style, columns, selectable } = options;
    const { color } = style;
    const width = Math.min(options.width, MAX_MESSAGE_WIDTH);
    if (messages.length === 0) {
      if (selectable) this.shownMessages = [];
      return left;
    }
    const marker = (message: MessageInfo) =>
      !selectable
        ? ""
        : messageKey(message) === this.selectedKey
          ? color("accent", "▸ ")
          : "  ";
    const markerWidth = selectable ? 2 : 0;
    const earlier = (hidden: number) =>
      color("dim", `${selectable ? "  " : ""}… ${hidden} earlier · /messages`);
    if (!columns) {
      const hidden = Math.max(0, messages.length - options.stacked);
      const shown = messages.slice(-options.stacked);
      if (selectable) this.shownMessages = shown;
      const column = pairWidth(shown.map(messageParts));
      return [
        ...left,
        color(
          "dim",
          `${selectable ? "  " : ""}${"─".repeat(Math.max(1, width - markerWidth))}`,
        ),
        ...(hidden > 0 ? [earlier(hidden)] : []),
        ...shown.map(
          (message) =>
            `${marker(message)}${formatMessageLine(messageParts(message), width - markerWidth, style, column)}`,
        ),
      ];
    }
    const height = Math.max(
      left.length,
      Math.min(messages.length, COLUMN_MIN_HEIGHT),
    );
    // A cut column gives its first row to the count of earlier messages.
    const cut = messages.length > height;
    const shown = messages.slice(-(cut ? height - 1 : height));
    if (selectable) this.shownMessages = shown;
    const leftWidth = Math.min(
      Math.max(...left.map((line) => visibleWidth(line))),
      Math.floor(options.width * AGENT_COLUMN_RATIO),
    );
    const rightWidth = Math.max(
      8,
      Math.min(MAX_MESSAGE_WIDTH, options.width - leftWidth - 3) - markerWidth,
    );
    const column = pairWidth(shown.map(messageParts));
    const separator = color("dim", " │ ");
    const rows: Array<MessageInfo | number> = cut
      ? [messages.length - shown.length, ...shown]
      : shown;
    return Array.from({ length: height }, (_, index) => {
      const message = rows[index];
      const right =
        typeof message === "number"
          ? earlier(message)
          : message
            ? `${marker(message)}${formatMessageLine(messageParts(message), rightWidth, style, column)}`
            : "";
      return `${padLine(left[index] ?? "", leftWidth)}${separator}${right}`;
    });
  }

  private frame(tui: TUI, theme: Theme, width: number): string[] {
    if (this.disposed || this.suppressed) return [];
    const rows = this.rows();
    if (rows.length === 0) return [];
    const ids = new Set(
      rows.flatMap((row) => (row.kind === "agent" ? [row.agent.id] : [])),
    );
    for (const id of this.held.keys()) if (!ids.has(id)) this.held.delete(id);
    const height = tui?.terminal?.rows ?? 24;
    const budget = Math.max(4, Math.floor(height * MAX_HEIGHT_RATIO));
    return this.lines(budget, themeStyle(theme), width);
  }

  private startTicking(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.update(), TICK_MS);
    this.timer.unref?.();
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.mounted) this.lastContext?.ui.setWidget(WIDGET_KEY, undefined);
    this.mounted = false;
    this.lastContext = undefined;
    this.lastTui = undefined;
    this.held.clear();
    this.stopTicking();
  }
}
