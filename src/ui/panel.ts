/**
 * RunPanel: the interactive above-editor summary of live workflow runs.
 *
 * Unfocused, it renders like the old passive widget: one line per running
 * run. Left-arrow from an empty editor (or ctrl+q) moves focus in; the panel
 * then shows a selection marker and navigates with ↑↓, expands a run into
 * its agent list with space, attaches to an agent with ⏎ (live transcript
 * for a running agent, its own pi session for a settled one), and cancels
 * with c. Because the panel sits above the editor, expanding grows upward
 * without moving the editor or footer.
 *
 * While an agent is attached, the panel shows that agent's transcript with
 * pi's native message renderers plus one status line, padded to a constant
 * height so the bottom region never changes size mid-attachment; the pi
 * editor stays in place as the agent's composer (submissions intercepted at
 * the editor, see ui/editor.ts).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TranscriptItem } from "../engine/types.js";
import type { RunManager } from "../run/runs.js";
import { type NodeView, type RunView, workNodes } from "../run/state.js";
import { AgentTranscriptView } from "./console.js";
import { formatUsage, nodeDisplayName } from "./render.js";
import { STATUS_STYLES } from "./status.js";
import {
  type Colorize,
  formatElapsed,
  formatRunWidget,
  type LiveActivity,
  liveActivity,
  visibleWidgetRuns,
} from "./widget.js";

const WIDGET_KEY = "pi-agents:runs";
const MAX_RUNS = 4;
// The glyph strip carries liveness through color, so no spinner animates;
// the tick refreshes elapsed time, stall hints, and held reasoning summaries.
const TICK_MS = 1000;
const SUMMARY_MIN_DISPLAY_MS = 3000;
/** Focused-panel height cap, as a fraction of the terminal. */
const MAX_HEIGHT_RATIO = 0.6;
/** Rows reserved for the editor's borders, footer, status, and margin when
 * budgeting the attached transcript (on top of the editor's 30% growth). */
const EDITOR_RESERVE_ROWS = 8;

export type PanelRow =
  | { kind: "run"; run: RunView }
  | { kind: "node"; run: RunView; node: NodeView };

export function rowKey(row: PanelRow): string {
  return row.kind === "run"
    ? `run:${row.run.header.id}`
    : `node:${row.run.header.id}:${row.node.instance}`;
}

/** One compact agent line inside an expanded run. Pure. */
export function formatNodeLine(
  node: NodeView,
  now: number,
  color: Colorize = (_c, t) => t,
): string {
  const presentation = STATUS_STYLES[node.status];
  const icon = color(presentation.color, presentation.icon);
  const usage = formatUsage(
    node.usage ?? (node.status === "running" ? node.progressUsage : undefined),
  );
  const elapsed = formatElapsed((node.endedAt ?? now) - node.startedAt);
  const activity =
    node.status === "running"
      ? (node.progressSummary ??
        (node.progressTool ? `Using ${node.progressTool}` : undefined))
      : node.error;
  const dot = color("dim", " · ");
  const parts = [
    `${icon} ${nodeDisplayName(node)}`,
    color("dim", node.agent ?? "ad-hoc"),
    color("dim", elapsed),
    usage ? color("dim", usage) : undefined,
    activity
      ? color(
          node.status === "failed" ? "error" : "dim",
          activity.replaceAll(/\s+/g, " ").trim(),
        )
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(dot);
}

/** The one-line status shown under an attached agent transcript. Pure. */
export function formatAttachedLine(
  run: RunView,
  node: NodeView,
  now: number,
  color: Colorize = (_c, t) => t,
): string {
  const presentation = STATUS_STYLES[node.status];
  const siblings = workNodes(run).filter(
    (candidate) =>
      candidate.instance !== node.instance && candidate.status === "running",
  ).length;
  const dot = color("dim", " · ");
  const parts = [
    `${color("muted", "❖")} ${run.header.label ?? run.header.flow.kind} ${color("dim", "›")} ${color(presentation.color, presentation.icon)} ${nodeDisplayName(node)}`,
    color("dim", node.agent ?? "ad-hoc"),
    color("dim", formatElapsed((node.endedAt ?? now) - node.startedAt)),
    siblings > 0 ? color("dim", `${siblings} sibling(s) running`) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(dot);
}

/**
 * Neutralize characters that desynchronize the differential renderer's width
 * accounting: tabs expand at the terminal's discretion and carriage returns
 * rewind the cursor, so one raw tool-output line can wrap and orphan the
 * whole frame (duplicated panels, vanished editor). ESC is kept for SGR
 * colors; every other C0 control byte is dropped.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping C0 bytes
const C0_CONTROL_BYTES = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;

export function sanitizeLine(line: string): string {
  return line.replaceAll("\t", "  ").replace(C0_CONTROL_BYTES, "");
}
class PanelLines implements Component {
  private readonly build: (width: number) => string[];

  constructor(build: (width: number) => string[]) {
    this.build = build;
  }

  invalidate(): void {
    // Content is a pure function of panel state; replaced wholesale on update.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.build(usable).map(
      (line) => ` ${truncateToWidth(sanitizeLine(line), usable, "…")}`,
    );
  }
}

export class RunPanel {
  private readonly manager: RunManager;
  private readonly now: () => number;
  private lastContext: ExtensionContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Run ids muted from the summary (session-scoped, via /workflows `h`). */
  private readonly hidden = new Set<string>();
  private enabled = true;
  /** True while the workflows panel owns the composer slot. */
  private suppressed = false;
  private readonly heldActivity = new Map<
    string,
    { activity: LiveActivity; shownAt: number; pending?: LiveActivity }
  >();

  /** Interactive state, driven by the focus controller. */
  private focused = false;
  private selectedKey: string | undefined;
  /** Runs the user explicitly collapsed; everything else shows its agents. */
  private readonly collapsed = new Set<string>();
  private attached: { runId: string; instance: string } | undefined;
  /** Native transcript renderer for the attached agent; per attachment. */
  private attachedView: AgentTranscriptView | undefined;
  /** The TUI from the last widget mount, for forced repaints. */
  private lastTui: TUI | undefined;
  /** Whether the persistent panel component is currently mounted. */
  private mounted = false;
  /** Last transcript snapshot, kept so a settled agent stays visible. */
  private attachedItems: readonly TranscriptItem[] | undefined;

  constructor(manager: RunManager, now: () => number = Date.now) {
    this.manager = manager;
    this.now = now;
  }

  update(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    const context = ctx ?? this.lastContext;
    // RPC exposes a UI bridge, but delegated/headless sessions must not start
    // widget timers or emit display requests. The panel belongs to the TUI.
    if (context?.mode !== "tui") return;
    this.lastContext = context;
    // Mount one persistent component and let it pull live state per render.
    // Replacing the component per update (the previous design) remounted the
    // widget container on every progress tick, which — combined with a
    // frame-to-frame height change — desynchronized pi's differential
    // renderer (duplicated rows, scrambled bottom region).
    if (!this.shouldShow()) {
      this.stopTicking();
      this.heldActivity.clear();
      this.focused = false;
      if (this.mounted) {
        context.ui.setWidget(WIDGET_KEY, undefined);
        this.mounted = false;
      }
      return;
    }
    this.startTicking();
    if (!this.mounted) {
      context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.lastTui = tui;
        return new PanelLines((width) => this.buildFrame(tui, theme, width));
      });
      this.mounted = true;
      return;
    }
    this.lastTui?.requestRender?.();
  }

  private shouldShow(): boolean {
    if (this.attached) return true;
    return this.enabled && !this.suppressed && this.running().length > 0;
  }

  isHidden(runId: string): boolean {
    return this.hidden.has(runId);
  }

  /** Show/hide one run in the summary. Returns true when now hidden. */
  toggleHidden(runId: string): boolean {
    if (!this.hidden.delete(runId)) this.hidden.add(runId);
    this.update();
    return this.hidden.has(runId);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Hide the summary while the workflows overlay is open: it sits in the
   * composer slot right below and reports the same run state.
   */
  setSuppressed(value: boolean): void {
    if (this.suppressed === value) return;
    this.suppressed = value;
    this.update();
  }

  /** Turn the whole live summary on/off. Returns the new state. */
  toggleEnabled(): boolean {
    this.enabled = !this.enabled;
    this.update();
    return this.enabled;
  }

  // -------------------------------------------------------------------------
  // Interactive surface, called by the focus controller.

  hasRows(): boolean {
    return this.running().length > 0;
  }

  isFocused(): boolean {
    return this.focused;
  }

  setFocused(value: boolean): void {
    if (this.focused === value) return;
    this.focused = value;
    if (value && this.selectedRow() === undefined) {
      const first = this.rows()[0];
      this.selectedKey = first ? rowKey(first) : undefined;
    }
    this.update();
  }

  setAttached(value: { runId: string; instance: string } | undefined): void {
    this.attached = value;
    this.attachedView?.dispose();
    this.attachedView = undefined;
    this.attachedItems = undefined;
    this.update();
    // Attach/detach swaps the widget's entire content and height and the
    // editor's border in one frame; the differential renderer can leave one
    // stale row behind and then believe the screen matches. Force a full
    // repaint on the next tick.
    setTimeout(() => {
      const tui = this.lastTui;
      if (!tui || this.disposed) return;
      tui.invalidate();
      tui.requestRender(true);
    }, 0);
  }

  attachedTarget(): { runId: string; instance: string } | undefined {
    return this.attached;
  }

  /** Scroll the attached transcript; positive delta moves toward newer. */
  scrollAttached(delta: number): void {
    const view = this.attachedView;
    if (!view) return;
    view.scrollBack = Math.max(
      0,
      Math.min(view.scrollBack - delta, view.maxScroll()),
    );
    this.update();
  }

  /** The flat, navigable row list: runs auto-expand into their agents so
   * navigation never needs an extra unpack keystroke; space collapses. */
  rows(): PanelRow[] {
    const rows: PanelRow[] = [];
    for (const run of this.running()) {
      rows.push({ kind: "run", run });
      if (!this.collapsed.has(run.header.id)) {
        for (const node of workNodes(run)) {
          rows.push({ kind: "node", run, node });
        }
      }
    }
    return rows;
  }

  selectedRow(): PanelRow | undefined {
    return this.reconcile(this.rows());
  }

  /** Normalize a stale selection (its run settled or collapsed away) to the
   * first remaining row, so rendering, movement, and activation agree. */
  private reconcile(rows: PanelRow[]): PanelRow | undefined {
    if (rows.length === 0) {
      this.selectedKey = undefined;
      return undefined;
    }
    const current = rows.find((row) => rowKey(row) === this.selectedKey);
    if (current) return current;
    const first = rows[0] as PanelRow;
    this.selectedKey = rowKey(first);
    return first;
  }

  /** Move the selection by delta rows. Returns false when moving above the
   * first row (the focus controller hands focus back to the editor). */
  move(delta: number): boolean {
    const rows = this.rows();
    if (this.reconcile(rows) === undefined) return false;
    const index = rows.findIndex((row) => rowKey(row) === this.selectedKey);
    const next = (index >= 0 ? index : 0) + delta;
    if (next >= rows.length) return true;
    if (next < 0) return false;
    this.selectedKey = rowKey(rows[next] as PanelRow);
    this.update();
    return true;
  }

  /** Space: collapse/re-expand the selected run (or the node's run). */
  toggleExpand(): void {
    const row = this.selectedRow();
    if (!row) return;
    const runId = row.run.header.id;
    if (this.collapsed.has(runId)) {
      this.collapsed.delete(runId);
    } else {
      this.collapsed.add(runId);
      this.selectedKey = `run:${runId}`;
    }
    this.update();
  }

  expandRun(runId: string): void {
    this.collapsed.delete(runId);
    this.update();
  }

  /** c: stop the selected run. */
  cancelSelected(): boolean {
    const row = this.selectedRow();
    if (!row) return false;
    return this.manager.stop(row.run.header.id);
  }

  private running(): RunView[] {
    return visibleWidgetRuns(this.manager.state.runs.values(), this.hidden);
  }

  private activityFor(run: RunView, now: number): LiveActivity {
    const candidate = liveActivity(run);
    const held = this.heldActivity.get(run.header.id);
    if (!held) {
      if (candidate.excerpt) {
        this.heldActivity.set(run.header.id, {
          activity: candidate,
          shownAt: now,
        });
      }
      return candidate;
    }
    if (candidate.excerpt !== undefined) {
      const candidateAt = candidate.at ?? 0;
      const same =
        held.activity.excerpt === candidate.excerpt &&
        held.activity.source === candidate.source;
      if (same) {
        if (held.pending && candidateAt >= (held.pending.at ?? 0)) {
          held.pending = undefined;
        }
        if (candidateAt >= (held.activity.at ?? 0)) held.activity = candidate;
      } else {
        const newestAt = held.pending?.at ?? held.activity.at ?? 0;
        if (candidateAt >= newestAt) held.pending = candidate;
      }
    }
    if (held.pending && now - held.shownAt >= SUMMARY_MIN_DISPLAY_MS) {
      held.activity = held.pending;
      held.pending = undefined;
      held.shownAt = now;
    }
    return { ...held.activity, lastAt: candidate.lastAt };
  }

  /** The attached agent's transcript (pi-native rendering) plus one status
   * line at the bottom, next to the editor that now feeds this agent. */
  private attachedLines(
    tui: TUI,
    width: number,
    rowsBudget: number,
    now: number,
    color: Colorize,
  ): string[] | undefined {
    if (!this.attached) return undefined;
    const { runId, instance } = this.attached;
    const run = this.manager.state.runs.get(runId);
    const node = run?.nodes.get(instance);
    if (!run || !node) return undefined;
    const handle = this.manager.liveHandle(runId, instance);
    if (handle?.transcript) this.attachedItems = handle.transcript();
    this.attachedView ??= new AgentTranscriptView(
      tui,
      run.header.cwd ?? process.cwd(),
    );
    const transcript = this.attachedView.render(
      this.attachedItems ?? [],
      width,
      Math.max(3, rowsBudget - 2),
    );
    const hints =
      node.status === "running"
        ? "type to talk to this agent · esc interrupt · ← back · shift+↑↓ scroll"
        : node.sessionFile
          ? "agent settled — /agent-session opens it · ← back"
          : "agent settled · ← back";
    return [
      ...transcript,
      "",
      `${formatAttachedLine(run, node, now, color)}${color("dim", " · ")}${color("dim", hints)}`,
    ];
  }

  /** The attached run and node, for the badge in the editor's top border. */
  attachedContext(): { run: RunView; node: NodeView } | undefined {
    if (!this.attached) return undefined;
    const run = this.manager.state.runs.get(this.attached.runId);
    const node = run?.nodes.get(this.attached.instance);
    return run && node ? { run, node } : undefined;
  }

  private buildLines(
    width: number,
    rowsBudget: number,
    now: number,
    color: Colorize,
    activities: Map<string, LiveActivity>,
  ): string[] {
    const rows = this.rows();
    if (!this.focused) {
      const running = this.running().slice(0, MAX_RUNS);
      const lines = running.flatMap((run) =>
        formatRunWidget(run, now, color, width, activities.get(run.header.id)),
      );
      const total = this.running().length;
      if (total > MAX_RUNS) {
        lines.push(color("dim", `…+${total - MAX_RUNS} more (see /workflows)`));
      }
      return lines;
    }
    // Focused: every row gets a marker column; window around the selection.
    this.reconcile(rows);
    const index = Math.max(
      0,
      rows.findIndex((row) => rowKey(row) === this.selectedKey),
    );
    const visible = Math.max(3, rowsBudget - 1);
    const start = Math.max(
      0,
      Math.min(index - Math.floor(visible / 2), rows.length - visible),
    );
    const lines: string[] = [];
    for (const [i, row] of rows.entries()) {
      if (i < start || i >= start + visible) continue;
      const marker = i === index ? color("accent", "▸ ") : "  ";
      if (row.kind === "run") {
        const [line = ""] = formatRunWidget(
          row.run,
          now,
          color,
          width - 2,
          activities.get(row.run.header.id),
        );
        lines.push(`${marker}${line}`);
      } else {
        lines.push(`${marker}  ${formatNodeLine(row.node, now, color)}`);
      }
    }
    if (rows.length > start + visible) {
      lines.push(color("dim", `  …+${rows.length - start - visible} more`));
    }
    lines.push(
      color(
        "dim",
        "  ↑↓ move · ⏎ attach · space collapse · c cancel · esc editor",
      ),
    );
    return lines;
  }

  /** One frame of the persistent component, from live state. */
  private buildFrame(tui: TUI, theme: Theme, width: number): string[] {
    if (this.disposed) return [];
    const color: Colorize = (name, text) => theme.fg(name, text);
    const now = this.now();
    const terminalRows = tui?.terminal?.rows ?? 24;
    const rowsBudget = Math.max(4, Math.floor(terminalRows * MAX_HEIGHT_RATIO));
    // The widget shares the persistent bottom region with the editor (which
    // grows to 30% of the terminal while composing), the footer, and status
    // rows. If their sum ever exceeds the screen, every redraw scrolls and
    // orphans the previous frame in the scrollback — so the attached
    // transcript reserves the editor's worst case explicitly instead of
    // taking a flat share.
    const attachedBudget = Math.max(
      6,
      Math.min(
        Math.floor(terminalRows * 0.5),
        terminalRows - Math.floor(terminalRows * 0.3) - EDITOR_RESERVE_ROWS,
      ),
    );
    const attached = this.attachedLines(tui, width, attachedBudget, now, color);
    if (attached) {
      // Constant height for the whole attachment: a bottom region whose
      // height changes with every streamed line is what desynchronized the
      // differential renderer. Pad at the top so content hugs the editor.
      while (attached.length < attachedBudget) attached.unshift("");
      return attached;
    }
    const running = this.running();
    if (running.length === 0) return [];
    const visibleIds = new Set(running.map((run) => run.header.id));
    for (const runId of this.heldActivity.keys()) {
      if (!visibleIds.has(runId)) this.heldActivity.delete(runId);
    }
    const activities = new Map(
      running.map((run) => [run.header.id, this.activityFor(run, now)]),
    );
    return this.buildLines(width, rowsBudget, now, color, activities);
  }

  private startTicking(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.update();
    }, TICK_MS);
    this.timer.unref?.();
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Detach session-bound state and stop animation (session shutdown). */
  dispose(): void {
    this.disposed = true;
    this.lastContext = undefined;
    this.heldActivity.clear();
    this.attachedView?.dispose();
    this.attachedView = undefined;
    this.stopTicking();
  }
}
