/**
 * AgentPanel: one line per open agent or group above the editor, a group's
 * agents indented below it.
 *
 *   ◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep
 *   ◉ review · group 1/2 · 40s · 12.0k
 *     ● api · terra · 4.0k
 *     ◉ tests · sol · 40s · 8.0k · Using grep
 *
 * Unfocused, it shows the first few lines, working ones first, and a
 * finished group as one line. Left arrow from an empty editor or Ctrl+Q
 * focuses it (see focus.ts); then ↑↓ select, ⏎ attaches (a group: its first
 * agent), `s` stops, and Esc returns to the editor.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentInfo } from "../agents/types.js";
import type { SessionHost } from "../pi/session.js";
import {
  type Colorize,
  formatAgentLine,
  formatGroupLine,
  sanitizeLine,
} from "./format.js";
import { buildRows, type EntryOrder, type Row } from "./rows.js";

const WIDGET_KEY = "pi-agents:panel";
const MAX_UNFOCUSED = 6;
const TICK_MS = 1000;
/** A reasoning headline stays at least this long before the next replaces it. */
const SUMMARY_MIN_DISPLAY_MS = 3000;
/** Focused-panel height cap, as a fraction of the terminal. */
const MAX_HEIGHT_RATIO = 0.6;

const STATE_ORDER = {
  working: 0,
  failed: 1,
  interrupted: 2,
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
  constructor(private readonly build: () => string[]) {}

  invalidate(): void {
    // Content is a pure function of panel state.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.build().map(
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
  private readonly held = new Map<string, HeldSummary>();

  constructor(
    private readonly host: SessionHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rows in panel order; `collapse` folds finished groups to one line. */
  rows(collapse = false): Row[] {
    const service = this.host.current();
    if (!service) return [];
    return buildRows(
      {
        agents: service.list(),
        groups: service.groups(),
        agent: (id) => service.get(id),
      },
      panelCompare,
      (group) => !collapse || group.state === "working",
    );
  }

  update(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    const context = ctx ?? this.lastContext;
    if (context?.mode !== "tui") return;
    this.lastContext = context;
    if (!this.shouldShow()) {
      this.stopTicking();
      this.focused = false;
      if (this.mounted) {
        context.ui.setWidget(WIDGET_KEY, undefined);
        this.mounted = false;
      }
      return;
    }
    this.startTicking();
    if (!this.mounted) {
      // One persistent component that pulls live state per render; remounting
      // per update desynchronizes Pi's differential renderer.
      context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.lastTui = tui;
        return new PanelLines(() => this.frame(tui, theme));
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

  /** The selected row, normalizing a stale selection to the first row. */
  selected(): Row | undefined {
    const rows = this.rows();
    const current = rows.find((row) => row.key === this.selectedKey);
    if (current) return current;
    this.selectedKey = rows[0]?.key;
    return rows[0];
  }

  /** Move the selection; returns false when moving above the first row. */
  move(delta: number): boolean {
    const rows = this.rows();
    const current = this.selected();
    if (!current) return false;
    const next = rows.findIndex((row) => row.key === current.key) + delta;
    if (next < 0) return false;
    if (next >= rows.length) return true;
    this.selectedKey = rows[next]?.key;
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

  private lines(budget: number, color: Colorize): string[] {
    const now = this.now();
    const line = (row: Row) =>
      row.kind === "group"
        ? formatGroupLine(row.group, now, color)
        : `${row.nested ? "  " : ""}${formatAgentLine(this.heldActivity(row.agent, now), now, color)}`;
    if (!this.focused) {
      const rows = this.rows(true);
      const shown = rows.slice(0, MAX_UNFOCUSED).map(line);
      if (rows.length > MAX_UNFOCUSED)
        shown.push(
          color("dim", `+${rows.length - MAX_UNFOCUSED} more (/agents)`),
        );
      return shown;
    }
    const rows = this.rows();
    const selected = this.selected();
    const index = selected
      ? Math.max(
          0,
          rows.findIndex((row) => row.key === selected.key),
        )
      : 0;
    const visible = Math.max(3, budget - 1);
    const start = Math.max(
      0,
      Math.min(index - Math.floor(visible / 2), rows.length - visible),
    );
    const lines = rows
      .slice(start, start + visible)
      .map(
        (row, offset) =>
          `${start + offset === index ? color("accent", "▸ ") : "  "}${line(row)}`,
      );
    if (rows.length > start + visible)
      lines.push(color("dim", `  …+${rows.length - start - visible} more`));
    lines.push(color("dim", "  ↑↓ move · ⏎ attach · s stop · esc editor"));
    return lines;
  }

  private frame(tui: TUI, theme: Theme): string[] {
    if (this.disposed || this.suppressed) return [];
    const rows = this.rows();
    if (rows.length === 0) return [];
    const ids = new Set(
      rows.flatMap((row) => (row.kind === "agent" ? [row.agent.id] : [])),
    );
    for (const id of this.held.keys()) if (!ids.has(id)) this.held.delete(id);
    const color: Colorize = (name, text) => theme.fg(name, text);
    const height = tui?.terminal?.rows ?? 24;
    const budget = Math.max(4, Math.floor(height * MAX_HEIGHT_RATIO));
    return this.lines(budget, color);
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
    this.held.clear();
    this.stopTicking();
  }
}
