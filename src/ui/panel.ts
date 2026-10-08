/**
 * AgentPanel: one line per open agent above the editor.
 *
 *   ◉ reviewer · explorer · terra · working 1m32s · 15.5k · Using grep
 *   ● docs · sol · idle 3m · 8.0k
 *
 * Unfocused, it shows the first few agents, working ones first. Left arrow
 * from an empty editor or Ctrl+Q focuses it (see focus.ts); then ↑↓ select,
 * ⏎ attaches, `s` stops, and Esc returns to the editor.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { type AgentInfo, formatModelRef } from "../agents/types.js";
import type { SessionHost } from "../pi/session.js";
import { type Colorize, formatAgentLine, sanitizeLine } from "./format.js";
import { shortModels } from "./model-label.js";

const WIDGET_KEY = "pi-agents:panel";
const MAX_UNFOCUSED = 4;
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

/** Open agents in panel order: working first, then newest first. */
export function panelOrder(agents: readonly AgentInfo[]): AgentInfo[] {
  return [...agents].sort(
    (left, right) =>
      STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
      right.createdAt - left.createdAt,
  );
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
  private selectedId: string | undefined;
  private readonly held = new Map<string, HeldSummary>();

  constructor(
    private readonly host: SessionHost,
    private readonly now: () => number = Date.now,
  ) {}

  agents(): AgentInfo[] {
    return panelOrder(this.host.current()?.list() ?? []);
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
    return !this.suppressed && this.agents().length > 0;
  }

  /** Hide the panel while a view in the editor slot shows the same agents. */
  setSuppressed(value: boolean): void {
    if (this.suppressed === value) return;
    this.suppressed = value;
    this.update();
  }

  hasRows(): boolean {
    return this.agents().length > 0;
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

  /** The selected agent, normalizing a stale selection to the first row. */
  selected(): AgentInfo | undefined {
    const agents = this.agents();
    const current = agents.find((agent) => agent.id === this.selectedId);
    if (current) return current;
    this.selectedId = agents[0]?.id;
    return agents[0];
  }

  /** Move the selection; returns false when moving above the first row. */
  move(delta: number): boolean {
    const agents = this.agents();
    const current = this.selected();
    if (!current) return false;
    const next = agents.indexOf(current) + delta;
    if (next < 0) return false;
    if (next >= agents.length) return true;
    this.selectedId = agents[next]?.id;
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

  private lines(
    agents: AgentInfo[],
    budget: number,
    color: Colorize,
  ): string[] {
    const now = this.now();
    const labels = shortModels(
      agents.flatMap((agent) =>
        agent.model ? [formatModelRef(agent.model)] : [],
      ),
    );
    const line = (agent: AgentInfo) =>
      formatAgentLine(
        this.heldActivity(agent, now),
        now,
        color,
        agent.model ? labels.get(formatModelRef(agent.model)) : undefined,
      );
    if (!this.focused) {
      const shown = agents.slice(0, MAX_UNFOCUSED).map(line);
      if (agents.length > MAX_UNFOCUSED)
        shown.push(
          color("dim", `+${agents.length - MAX_UNFOCUSED} more (/agents)`),
        );
      return shown;
    }
    const selected = this.selected();
    const index = selected ? Math.max(0, agents.indexOf(selected)) : 0;
    const visible = Math.max(3, budget - 1);
    const start = Math.max(
      0,
      Math.min(index - Math.floor(visible / 2), agents.length - visible),
    );
    const lines = agents
      .slice(start, start + visible)
      .map(
        (agent, offset) =>
          `${start + offset === index ? color("accent", "▸ ") : "  "}${line(agent)}`,
      );
    if (agents.length > start + visible)
      lines.push(color("dim", `  …+${agents.length - start - visible} more`));
    lines.push(color("dim", "  ↑↓ move · ⏎ attach · s stop · esc editor"));
    return lines;
  }

  private frame(tui: TUI, theme: Theme): string[] {
    if (this.disposed || this.suppressed) return [];
    const agents = this.agents();
    if (agents.length === 0) return [];
    const ids = new Set(agents.map((agent) => agent.id));
    for (const id of this.held.keys()) if (!ids.has(id)) this.held.delete(id);
    const color: Colorize = (name, text) => theme.fg(name, text);
    const rows = tui?.terminal?.rows ?? 24;
    const budget = Math.max(4, Math.floor(rows * MAX_HEIGHT_RATIO));
    return this.lines(agents, budget, color);
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
