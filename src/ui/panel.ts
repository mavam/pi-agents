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
 * pi's native message renderers plus one status line; the pi editor stays in
 * place as the agent's composer (input routed via the `input` event).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** Reverse-video wrap, so the label reads as a badge in any theme. */
function inverted(text: string): string {
  return `\u001b[7m${text}\u001b[27m`;
}

/**
 * The rule directly above the editor while attached, carrying a right-aligned
 * inverted badge that names the agent the editor now feeds:
 *
 *   ──────────────────────────────── scout · dummy-sleep60-1 ──
 */
export function attachedRule(
  run: RunView,
  node: NodeView,
  width: number,
  color: Colorize = (_c, t) => t,
): string {
  const label = ` ${nodeDisplayName(node)}${node.agent ? ` (${node.agent})` : ""} · ${run.header.label ?? run.header.flow.kind} `;
  const badge = inverted(label);
  const tail = 2;
  const lead = Math.max(1, width - label.length - tail);
  return `${color("dim", "─".repeat(lead))}${badge}${color("dim", "─".repeat(tail))}`;
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
      (line) => ` ${truncateToWidth(line, usable, "…")}`,
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
  private readonly expanded = new Set<string>();
  private attached: { runId: string; instance: string } | undefined;
  /** Native transcript renderer for the attached agent; per attachment. */
  private attachedView: AgentTranscriptView | undefined;
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
    this.render(context);
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

  /** The flat, navigable row list: runs, with agents under expanded runs. */
  rows(): PanelRow[] {
    const rows: PanelRow[] = [];
    for (const run of this.running()) {
      rows.push({ kind: "run", run });
      if (this.expanded.has(run.header.id)) {
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

  /** Space: expand/collapse the selected run (or the selected node's run). */
  toggleExpand(): void {
    const row = this.selectedRow();
    if (!row) return;
    const runId = row.run.header.id;
    if (this.expanded.has(runId)) {
      this.expanded.delete(runId);
      this.selectedKey = `run:${runId}`;
    } else {
      this.expanded.add(runId);
    }
    this.update();
  }

  expandRun(runId: string): void {
    this.expanded.add(runId);
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
      Math.max(3, rowsBudget - 3),
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
      attachedRule(run, node, width, color),
    ];
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
        "  ↑↓ move · space expand · ⏎ attach · c cancel · esc editor",
      ),
    );
    return lines;
  }

  private render(context: ExtensionContext): void {
    if (this.disposed) return;
    const running = this.enabled && !this.suppressed ? this.running() : [];
    if (running.length === 0 && !this.attached) {
      this.stopTicking();
      this.heldActivity.clear();
      this.focused = false;
      context.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    this.startTicking();
    const now = this.now();
    const visibleIds = new Set(running.map((run) => run.header.id));
    for (const runId of this.heldActivity.keys()) {
      if (!visibleIds.has(runId)) this.heldActivity.delete(runId);
    }
    const activities = new Map(
      running.map((run) => [run.header.id, this.activityFor(run, now)]),
    );
    context.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      const terminalRows = tui?.terminal?.rows ?? 24;
      const rowsBudget = Math.max(
        4,
        Math.floor(terminalRows * MAX_HEIGHT_RATIO),
      );
      return new PanelLines((width) => {
        const attached = this.attachedLines(tui, width, rowsBudget, now, color);
        if (attached) return attached;
        return this.buildLines(width, rowsBudget, now, color, activities);
      });
    });
  }

  private startTicking(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      if (this.disposed) return;
      const context = this.lastContext;
      if (context) this.render(context);
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
