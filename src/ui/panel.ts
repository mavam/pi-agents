/**
 * AgentPanel: the open agents above the editor. Unfocused, it's one line
 * with how many agents are in each state:
 *
 *   ◉ 3 working ● 1 idle · ← agents
 *
 * Left arrow from an empty editor, Ctrl+Q, or a click on that line focuses
 * it (see focus.ts). Focused, it shows one line per open agent or graph, a
 * graph's agents below it as a tree, working ones first:
 *
 *   ◉ reviewer explorer terra 1m32s 15.5k Using grep
 *   ◉ review graph 1/3 40s 12.0k
 *   ├─ ● api terra 4.0k
 *   ├─ ◉ tests sol 40s 8.0k Using grep
 *   └─ ○ merge after all opus
 *
 * Names are in the normal color and details dim, separated by single
 * spaces. ↑↓ select, space folds a graph or the agents an agent spawned,
 * ⏎ attaches (a graph: its first agent), `s` stops, Tab opens `/agents` at
 * the selected row, and Esc returns to the editor.
 *
 * It also shows messages still queued for their
 * recipients, in a column to the right of the agents from 120 terminal
 * columns, else below them; delivered ones are history, in the transcript
 * and `/messages`:
 *
 *   ◉ scout sol 40s 8.1k   scout → notes README.md is 18 KB 3s
 *
 * The agents get a fixed share of the panel, so the message column doesn't
 * move while messages come and go. ↑↓ continue from the agents into the
 * messages, ⏎ on a message attaches to its recipient, and `m` opens
 * `/messages` at the selected message, or filtered by the selected agent.
 *
 * In Pi's fullscreen mode, which reports the mouse, a click on a row
 * attaches like ⏎: an agent row to the agent, a graph row to its first
 * agent, and a message to its recipient.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentInfo, MessageInfo } from "../agents/types.js";
import type { SessionHost } from "../pi/session.js";
import {
  formatAgentLine,
  formatElapsed,
  formatGraphLine,
  sanitizeLine,
  statusCounts,
  statusGlyph,
} from "./format.js";
import { fitHints } from "./frame.js";
import {
  type MessageParts,
  type MessageStyle,
  messageLine,
  messageParts,
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
const TICK_MS = 1000;
/** A reasoning headline stays at least this long before the next replaces it. */
const SUMMARY_MIN_DISPLAY_MS = 3000;
/** Focused-panel height cap, as a fraction of the terminal. */
const MAX_HEIGHT_RATIO = 0.6;
/** The most messages stacked below the agents. */
const STACKED_MESSAGES = 6;
/** Below this width, columns stack. */
const COLUMNS_MIN_WIDTH = 120;
/** The fewest rows the message column shows, when there are messages. */
const COLUMN_MIN_HEIGHT = 3;
/** The agent column's share of the panel in columns. */
const AGENT_COLUMN_RATIO = 0.45;

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

/** What a click on a panel line does: attach to the agent of its left
 * part, and in columns, the recipient of its right part from `split`; or,
 * on the summary line, focus the panel. */
interface LineTarget {
  left?: string;
  right?: string;
  split?: number;
  focus?: boolean;
}

class PanelLines implements Component {
  constructor(
    private readonly build: (width: number) => string[],
    private readonly click: (line: number, column: number) => boolean,
  ) {}

  invalidate(): void {
    // Content is a pure function of panel state.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.build(usable).map(
      (line) => ` ${truncateToWidth(sanitizeLine(line), usable, "…")}`,
    );
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    // Lines start after one column of padding.
    return this.click(event.y, event.x - 1) ? { handled: true } : undefined;
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
  /** What each line of the latest frame attaches to when clicked. */
  private targets: LineTarget[] = [];
  /** Attaches to an agent, by ID; the host wires it to focus. */
  onAttach: ((agentId: string) => void) | undefined;
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

  /** Queued messages of the agents the panel shows, oldest first. */
  messages(): MessageInfo[] {
    const service = this.host.current();
    if (!service) return [];
    const shown = new Set(service.list().map((info) => info.id));
    return service
      .messages()
      .filter(
        (message) =>
          message.status === "queued" &&
          (shown.has(message.from.id) || shown.has(message.to.id)),
      );
  }

  /** A queued message's line parts, with how long it has waited. */
  private parts(message: MessageInfo): MessageParts {
    return {
      ...messageParts(message),
      age: formatElapsed(this.now() - message.sentAt),
    };
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
    if (!this.shouldShow()) this.focused = false;
    // Only the focused panel shows times; the summary line changes with the
    // agents, which update the panel themselves.
    if (this.focused) this.startTicking();
    else this.stopTicking();
    if (!this.mounted) {
      // One persistent component that pulls live state per render; remounting
      // per update desynchronizes Pi's differential renderer. Keep the empty
      // widget mounted too, so keyboard guards always have the current TUI.
      context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.lastTui = tui;
        return new PanelLines(
          (width) => this.frame(tui, theme, width),
          (line, column) => this.click(line, column),
        );
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

  /** Whether an editor owns terminal input, rather than a selector or dialog. */
  isEditorFocused(): boolean {
    const tui = this.lastTui;
    // Pi's renderers expose this query, but the shared TUI interface doesn't.
    if (
      !tui ||
      !("getFocusedComponent" in tui) ||
      typeof tui.getFocusedComponent !== "function"
    )
      return false;
    // Don't guess where input will go after a dynamically hidden overlay:
    // Pi restores that focus after raw listeners, so yield until it has.
    const component: Component | null = tui.getFocusedComponent();
    // Use the EditorComponent contract: custom editors needn't extend Editor,
    // and instanceof isn't reliable across Pi's extension loader boundaries.
    return (
      component !== null &&
      "getText" in component &&
      typeof component.getText === "function" &&
      "setText" in component &&
      typeof component.setText === "function" &&
      typeof component.handleInput === "function"
    );
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

  /** One line for all agents: how many are in each state. */
  private summaryLine(style: MessageStyle): string {
    const { color } = style;
    const agents = this.host.current()?.list() ?? [];
    const counts = statusCounts(agents).map(
      ([status, count]) => `${statusGlyph(status, color)} ${count} ${status}`,
    );
    return `${counts.join(" ")}${color("dim", " · ← agents")}`;
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
    // `width` leaves out the panel's padding column.
    const columns = width + 1 >= COLUMNS_MIN_WIDTH;
    const line = (row: Row) => {
      const text =
        row.kind === "graph"
          ? formatGraphLine({ ...row.graph, name: row.label }, now, color)
          : formatAgentLine(
              { ...this.heldActivity(row.agent, now), name: row.label },
              now,
              color,
              row.inputs,
              row.others,
            );
      const hidden = hiddenNote(row);
      return `${color("dim", connector(row))}${text}${hidden ? color("dim", ` ${hidden}`) : ""}`;
    };
    if (!this.focused) {
      this.shownMessages = [];
      this.targets = [{ focus: true }];
      return [this.summaryLine(style)];
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
        ? 1 + Math.min(messages.length, STACKED_MESSAGES)
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
    const targets = rows.slice(start, start + visible).map(attachTarget);
    if (rows.length > start + visible)
      agentLines.push(
        color("dim", `  …+${rows.length - start - visible} more`),
      );
    const lines = this.withMessages(agentLines, targets, messages, {
      width,
      style,
      columns,
    });
    const message = this.selectedMessage();
    const hints = [
      "↑↓ move",
      ...(message
        ? [`⏎ attach ${message.to.name}`]
        : ["space fold", "⏎ attach", "s stop"]),
      "m messages",
      "tab /agents",
      "esc back",
    ];
    lines.push(color("dim", `  ${fitHints(hints, width - 2)}`));
    this.targets.push({});
    return lines;
  }

  /**
   * Agent lines with the latest messages below them, stacked, or to their
   * right, in a column as tall as theirs. `selectable` makes the shown
   * messages reachable with ↑↓ and marks the selected one.
   */
  private withMessages(
    left: string[],
    /** The agents the left lines attach to, by line. */
    leftTargets: ReadonlyArray<string | undefined>,
    messages: readonly MessageInfo[],
    options: { width: number; style: MessageStyle; columns: boolean },
  ): string[] {
    const { style, columns, width } = options;
    const { color } = style;
    if (messages.length === 0) {
      this.shownMessages = [];
      this.targets = left.map((_, index) => ({ left: leftTargets[index] }));
      return left;
    }
    const marker = (message: MessageInfo) =>
      messageKey(message) === this.selectedKey ? color("accent", "▸ ") : "  ";
    const markerWidth = 2;
    // The newest messages that fit; a first row counts the older ones,
    // which `/messages` shows.
    const window = (rows: number) => {
      if (messages.length <= rows) return { shown: [...messages], more: 0 };
      const shown = messages.slice(-Math.max(1, rows - 1));
      return { shown, more: messages.length - shown.length };
    };
    const moreLine = (more: number) =>
      color("dim", `  +${more} more · m messages`);
    if (!columns) {
      const { shown, more } = window(STACKED_MESSAGES);
      this.shownMessages = shown;
      this.targets = [
        ...left.map((_, index) => ({ left: leftTargets[index] })),
        {},
        ...(more > 0 ? [{}] : []),
        ...shown.map((message) => ({ left: message.to.id })),
      ];
      return [
        ...left,
        color("dim", `  ${"─".repeat(Math.max(1, width - markerWidth))}`),
        ...(more > 0 ? [moreLine(more)] : []),
        ...shown.map(
          (message) =>
            `${marker(message)}${messageLine(this.parts(message), width - markerWidth, style)}`,
        ),
      ];
    }
    const height = Math.max(
      left.length,
      Math.min(messages.length, COLUMN_MIN_HEIGHT),
    );
    const { shown: newest, more } = window(height);
    this.shownMessages = newest;
    const shown: Array<MessageInfo | undefined> =
      more > 0 ? [undefined, ...newest] : newest;
    const leftWidth = Math.floor(width * AGENT_COLUMN_RATIO);
    const rightWidth = Math.max(8, width - leftWidth - 1 - markerWidth);
    // A gap, not a bar, separates the columns.
    const separator = " ";
    this.targets = Array.from({ length: height }, (_, index) => ({
      left: leftTargets[index],
      right: shown[index]?.to.id,
      split: leftWidth + separator.length,
    }));
    return Array.from({ length: height }, (_, index) => {
      const message = shown[index];
      const right = message
        ? `${marker(message)}${messageLine(this.parts(message), rightWidth, style)}`
        : index === 0 && more > 0
          ? moreLine(more)
          : "";
      return `${padLine(left[index] ?? "", leftWidth)}${separator}${right}`;
    });
  }

  /** A click on a line attaches to what it shows, or focuses the panel
   * from its summary line; whether it did. */
  private click(line: number, column: number): boolean {
    const target = this.targets[line];
    if (target?.focus) {
      this.setFocused(true);
      return true;
    }
    const agentId =
      target?.split !== undefined && column >= target.split
        ? target.right
        : target?.left;
    if (!agentId || !this.onAttach) return false;
    this.onAttach(agentId);
    return true;
  }

  private frame(tui: TUI, theme: Theme, width: number): string[] {
    this.targets = [];
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
