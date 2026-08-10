/**
 * The above-editor widget for live runs: one line per run.
 *
 *   ❖ review · ✦2/3 · 1m32s · 15.5k · ✦⑃⟨✦✦⑂⟩⇶↺ · merging…
 *
 * The static ❖ run mark acts as a bullet for each workflow. After the label,
 * the completed/known agent count uses the same ✦A/T iconography as the
 * pi-fancy-footer contribution — the denominator grows as map items are
 * discovered — followed by elapsed time and the live token count
 * (completed usage + streaming usage), the glyph strip, then the latest
 * output excerpt —
 * replaced by a "no output for …" stall hint when agents have been silent.
 * The strip shows one kind glyph per top-level unit (✦ marks an agent),
 * colored by status; failed units render ✗ so failures survive without
 * color. Running composites expand their children in ⟨…⟩ — recursively, so
 * the strip zooms into the active spine — while map items and loop
 * iterations always collapse to one glyph each, capped with an ellipsis.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SpawnUsage } from "../engine/types.js";
import {
  bodyPath,
  branchPath,
  casePath,
  elsePath,
  type FlowNode,
  reducePath,
  stepPath,
} from "../model/ast.js";
import type { RunManager } from "../run/runs.js";
import { type RunView, workNodes } from "../run/state.js";
import { formatTokens } from "./render.js";
import { STATUS_STYLES } from "./status.js";
import { aggregateStatuses, KIND_ICONS, type PathStatus } from "./tree.js";

const WIDGET_KEY = "pi-agents:runs";
const MAX_RUNS = 4;
// The glyph strip carries liveness through color, so no spinner animates;
// the tick only refreshes elapsed time and stall hints at their granularity.
const TICK_MS = 1000;

type SegmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WidgetSegment {
  glyph: string;
  status: SegmentStatus;
  /** Immediate children; present only while this composite is running. */
  children?: WidgetSegment[];
}

/** Fan-out wider than this collapses into a dim ellipsis glyph. */
const MAX_ITEM_GLYPHS = 8;

/** Kind glyphs for the strip; ✦ marks an agent, ⑂ a parallel reducer. */
const KIND_GLYPHS: Record<FlowNode["kind"], string> = {
  agent: KIND_ICONS.agent,
  sequence: "≡",
  parallel: "⑃",
  map: "⇶",
  loop: "↺",
  while: "↺",
  switch: "⎇",
  value: "≔",
  workflow: "❖",
};

/** Colors used by the widget; the identity function makes it testable. */
export type Colorize = (
  color: "success" | "accent" | "warning" | "muted" | "dim" | "error" | "text",
  text: string,
) => string;

export const plainColorize: Colorize = (_color, text) => text;

/**
 * Width-aware widget lines: content is (re)built per render with the actual
 * terminal width, so each run line can budget its label and meta parts to
 * keep the glyph strip visible. Lines are still truncated (ANSI-aware) as a
 * last resort, never wrapped.
 */
class WidthAwareLines implements Component {
  private readonly build: (width: number) => string[];

  constructor(build: (width: number) => string[]) {
    this.build = build;
  }

  invalidate(): void {
    // Content is a pure function of run state; the widget is replaced
    // wholesale on updates.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.build(usable).map(
      (line) => ` ${truncateToWidth(line, usable, "…")}`,
    );
  }
}

/**
 * Status for one depth-1 unit: liveness from the unit's own node (when it
 * has started), otherwise derived from the agent/reduce work in its subtree
 * — so a parallel glyph turns green only once all of its agents finished.
 */
function unitStatus(
  statuses: Map<string, PathStatus>,
  path: string,
): SegmentStatus {
  const own = statuses.get(path);
  if (own) return own.status;
  let running = 0;
  let failed = 0;
  let total = 0;
  for (const [key, status] of statuses) {
    if (key !== path && !key.startsWith(`${path}.`)) continue;
    if (status.kind !== "agent" && status.kind !== "reduce") continue;
    total += status.total;
    if (status.status === "running") running += 1;
    if (status.status === "failed") failed += 1;
  }
  if (total === 0) return "pending";
  return running > 0 ? "running" : failed > 0 ? "failed" : "completed";
}

/** Per-path node statuses in first-seen order (map items, loop iterations). */
export function instanceStatuses(run: RunView): Map<string, SegmentStatus[]> {
  const byPath = new Map<string, SegmentStatus[]>();
  for (const instance of run.order) {
    const node = run.nodes.get(instance);
    if (!node) continue;
    const list = byPath.get(node.path) ?? [];
    list.push(node.status);
    byPath.set(node.path, list);
  }
  return byPath;
}

/**
 * One glyph per top-level unit. The tool-call box carries the full vertical
 * structure; the widget summarizes horizontally: a sequence root yields one
 * glyph per top-level step, a parallel root one per branch (plus ⑂ for the
 * reducer). Running composites expand recursively along the active spine:
 * sequences, parallels, switches (the chosen arm), and workflow bodies show
 * their children, while everything else — completed, pending, failed units,
 * and all map items and loop iterations — collapses to one glyph. Fan-out is
 * therefore bounded: items never multiply with depth, and a cap adds a dim
 * ellipsis when a map discovers more items than fit.
 */
export function widgetSegments(
  flow: FlowNode,
  statuses: Map<string, PathStatus>,
  instances: Map<string, SegmentStatus[]> = new Map(),
): WidgetSegment[] {
  const unit = (node: FlowNode, path: string): WidgetSegment => {
    const status = unitStatus(statuses, path);
    const segment: WidgetSegment = { glyph: KIND_GLYPHS[node.kind], status };
    if (status !== "running") return segment;
    const children = expand(node, path);
    if (children && children.length > 0) segment.children = children;
    return segment;
  };

  /** One collapsed glyph per body instance (map items, loop iterations). */
  const itemGlyphs = (path: string, glyph: string): WidgetSegment[] => {
    const seen = instances.get(path) ?? [];
    const shown: WidgetSegment[] = seen
      .slice(0, MAX_ITEM_GLYPHS)
      .map((status) => ({ glyph, status }));
    // Pending status renders the overflow ellipsis dim, like the delimiters.
    if (seen.length > MAX_ITEM_GLYPHS) {
      shown.push({ glyph: "…", status: "pending" });
    }
    return shown;
  };

  const expand = (
    node: FlowNode,
    path: string,
  ): WidgetSegment[] | undefined => {
    switch (node.kind) {
      case "sequence":
        return node.steps.map((step, index) =>
          unit(step, stepPath(path, index)),
        );
      case "parallel": {
        const children = Object.entries(node.branches).map(([key, branch]) =>
          unit(branch, branchPath(path, key)),
        );
        if (node.reduce) {
          children.push({
            glyph: "⑂",
            status: unitStatus(statuses, reducePath(path)),
          });
        }
        return children;
      }
      case "switch": {
        // Only the chosen arm has instances; unchosen arms never ran.
        for (const [index, arm] of node.cases.entries()) {
          const armPath = casePath(path, index);
          if (statuses.has(armPath)) return [unit(arm.then, armPath)];
        }
        const fallback = elsePath(path);
        return statuses.has(fallback) ? [unit(node.else, fallback)] : undefined;
      }
      case "map": {
        const children = itemGlyphs(
          bodyPath(path),
          KIND_GLYPHS[node.body.kind],
        );
        // The reducer is map work too — without it a map whose items all
        // finished would expand to only-green glyphs while still running.
        if (node.reduce) {
          children.push({
            glyph: "⑂",
            status: unitStatus(statuses, reducePath(path)),
          });
        }
        return children;
      }
      case "loop":
      case "while":
        return itemGlyphs(bodyPath(path), KIND_GLYPHS[node.body.kind]);
      case "workflow":
        return node.body ? [unit(node.body, bodyPath(path))] : undefined;
      case "agent":
      case "value":
        return undefined;
    }
  };

  // Unwrap workflow refs so the inlined body's shape drives the summary.
  let root = flow;
  let rootPath = "$";
  while (root.kind === "workflow" && root.body) {
    root = root.body;
    rootPath = bodyPath(rootPath);
  }

  if (root.kind === "sequence") {
    return root.steps.map((step, index) =>
      unit(step, stepPath(rootPath, index)),
    );
  }
  if (root.kind === "parallel") {
    const segments = Object.entries(root.branches).map(([key, branch]) =>
      unit(branch, branchPath(rootPath, key)),
    );
    if (root.reduce) {
      segments.push({
        glyph: "⑂",
        status: unitStatus(statuses, reducePath(rootPath)),
      });
    }
    return segments;
  }
  return [unit(root, rootPath)];
}

/** Count agent-bearing leaves in the static skeleton (iterative bodies once). */
function countStaticLeaves(node: FlowNode): number {
  switch (node.kind) {
    case "agent":
      return 1;
    case "sequence":
      return node.steps.reduce((sum, step) => sum + countStaticLeaves(step), 0);
    case "parallel":
      return (
        Object.values(node.branches).reduce(
          (sum, branch) => sum + countStaticLeaves(branch),
          0,
        ) + (node.reduce ? 1 : 0)
      );
    case "map":
      return countStaticLeaves(node.body) + (node.reduce ? 1 : 0);
    case "loop":
    case "while":
      return countStaticLeaves(node.body);
    case "switch":
      // Exactly one arm runs; count the smallest so the total is an
      // underestimate that self-corrects as real instances appear (an
      // overestimate would leave finished runs looking incomplete).
      return Math.min(
        ...node.cases.map((arm) => countStaticLeaves(arm.then)),
        countStaticLeaves(node.else),
      );
    case "value":
      return 0;
    case "workflow":
      return node.body ? countStaticLeaves(node.body) : 1;
  }
}

/** Completion over known agents: seen instances plus unstarted skeleton leaves. */
export function widgetProgress(run: RunView): { done: number; total: number } {
  const agentNodes = workNodes(run);
  const done = agentNodes.filter((node) => node.status === "completed").length;
  const seenPaths = new Set(agentNodes.map((node) => node.path)).size;
  const unstarted = Math.max(0, countStaticLeaves(run.header.flow) - seenPaths);
  return { done, total: agentNodes.length + unstarted };
}

function liveTokens(run: RunView): number {
  let tokens = 0;
  for (const node of run.nodes.values()) {
    const usage: SpawnUsage | undefined =
      node.usage ??
      (node.status === "running" ? node.progressUsage : undefined);
    if (usage) tokens += usage.input + usage.output;
  }
  return tokens;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** A running agent counts as silent after this much time without updates. */
export const STALL_AFTER_MS = 60_000;

export interface LiveActivity {
  /** Latest provider-supplied reasoning summary from a running agent. */
  excerpt?: string;
  /** Most recent progress timestamp across all running agents. */
  lastAt?: number;
}

export function liveActivity(run: RunView): LiveActivity {
  let lastAt: number | undefined;
  let bestSummary:
    | { seen: number; startedAt: number; text: string }
    | undefined;
  for (const node of run.nodes.values()) {
    // Only work leaves report progress; structural nodes just wrap them.
    if (node.kind !== "agent" && node.kind !== "reduce") continue;
    if (node.status !== "running") continue;
    const seen = node.lastProgressAt ?? node.startedAt;
    if (lastAt === undefined || seen > lastAt) lastAt = seen;
    if (
      node.progressSummary &&
      (!bestSummary ||
        seen > bestSummary.seen ||
        (seen === bestSummary.seen && node.startedAt > bestSummary.startedAt))
    ) {
      bestSummary = {
        seen,
        startedAt: node.startedAt,
        text: node.progressSummary,
      };
    }
  }
  return { excerpt: bestSummary?.text.trim(), lastAt };
}

/** Labels never shrink below this many columns before meta gives way. */
const MIN_LABEL_WIDTH = 8;

/**
 * The one widget line for one run. Pure — testable with plainColorize.
 * Width-aware: on narrow terminals meta parts are dropped by usefulness
 * (tokens, then elapsed) and the label shrinks toward a floor, so the glyph
 * strip always survives. The excerpt
 * tail is unbounded and absorbs the final right-truncation at render time.
 */
export function formatRunWidget(
  run: RunView,
  now: number,
  color: Colorize = plainColorize,
  width = Number.POSITIVE_INFINITY,
): string[] {
  const { done, total } = widgetProgress(run);
  const progress = `${color("success", KIND_GLYPHS.agent)}${done}/${total}`;
  const label = run.header.label ?? run.header.flow.kind;
  const tokens = liveTokens(run);
  const activity = liveActivity(run);
  const dot = color("dim", " · ");
  const elapsed = formatElapsed(now - run.createdAt);
  const tokensPart = tokens > 0 ? formatTokens(tokens) : undefined;
  // In drop priority: the last entry goes first when space runs out.
  const metaParts = [elapsed, tokensPart].filter(
    (part): part is string => part !== undefined,
  );
  // A long silence is more informative than a stale excerpt: surface it.
  const stalledFor =
    activity.lastAt !== undefined ? now - activity.lastAt : undefined;
  const tail =
    stalledFor !== undefined && stalledFor > STALL_AFTER_MS
      ? color("warning", `no output for ${formatElapsed(stalledFor)}`)
      : activity.excerpt
        ? color("dim", activity.excerpt)
        : undefined;

  const statuses = aggregateStatuses(run);
  const segments = widgetSegments(
    run.header.flow,
    statuses,
    instanceStatuses(run),
  );
  // Failure must survive without color: ✗ replaces the kind glyph.
  const renderSegment = (segment: WidgetSegment): string => {
    const presentation = STATUS_STYLES[segment.status];
    const glyph =
      segment.status === "failed" ? presentation.icon : segment.glyph;
    const own = color(presentation.color, glyph);
    if (!segment.children) return own;
    const inner = segment.children.map(renderSegment).join("");
    return `${own}${color("dim", "⟨")}${inner}${color("dim", "⟩")}`;
  };
  const redundantSingleAgent =
    segments.length === 1 &&
    segments[0]?.glyph === KIND_GLYPHS.agent &&
    segments[0].children === undefined &&
    segments[0].status !== "failed";
  const strip = redundantSingleAgent
    ? ""
    : segments.map(renderSegment).join("");

  // Budget everything left of the strip so the strip always fits. Widths
  // are measured on colored strings — visibleWidth is ANSI-aware.
  const sepWidth = 3; // " · "
  const fixedWidth =
    visibleWidth(`❖ ${progress}`) +
    sepWidth * (strip ? 2 : 1) +
    visibleWidth(strip);
  const metaWidth = (parts: string[]): number =>
    parts.reduce((sum, part) => sum + visibleWidth(part) + sepWidth, 0);
  const labelFloor = Math.min(visibleWidth(label), MIN_LABEL_WIDTH);
  const kept = [...metaParts];
  // Tokens, then elapsed, give way only when the label would sink below
  // its readable floor.
  while (kept.length > 0 && width - fixedWidth - metaWidth(kept) < labelFloor) {
    kept.pop();
  }
  const labelBudget = Math.max(
    labelFloor,
    width - fixedWidth - metaWidth(kept),
  );
  const shownLabel =
    visibleWidth(label) > labelBudget
      ? truncateToWidth(label, labelBudget, "…")
      : label;
  // Restore display order (elapsed · tokens) for whatever survived.
  const meta = [elapsed, tokensPart]
    .filter((part): part is string => part !== undefined && kept.includes(part))
    .map((part) => color("dim", part))
    .join(dot);

  // The strip precedes the excerpt: that tail has unbounded width, and
  // truncation must never push the liveness glyphs off screen.
  return [
    `${color("muted", "❖")} ${shownLabel}${dot}${progress}${meta ? `${dot}${meta}` : ""}${strip ? `${dot}${strip}` : ""}${tail ? `${dot}${tail}` : ""}`,
  ];
}

/** Runs the widget shows: live, and not individually hidden. Pure. */
export function visibleWidgetRuns(
  runs: Iterable<RunView>,
  hiddenRunIds: ReadonlySet<string>,
): RunView[] {
  return [...runs].filter(
    (run) => run.status === "running" && !hiddenRunIds.has(run.header.id),
  );
}

export class RunWidget {
  private readonly manager: RunManager;
  private lastContext: ExtensionContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Run ids muted from the summary (session-scoped, via the /workflows overlay `h`). */
  private readonly hidden = new Set<string>();
  private enabled = true;
  /** True while the workflows panel owns the composer slot. */
  private suppressed = false;

  constructor(manager: RunManager) {
    this.manager = manager;
  }

  update(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    const context = ctx ?? this.lastContext;
    // RPC exposes a UI bridge, but delegated/headless sessions must not start
    // widget timers or emit display requests. The widget belongs to the TUI.
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
   * Hide the summary while the workflows panel is open: the panel sits in the
   * composer slot right below it and reports the same run state, so the widget
   * is pure duplication there. Orthogonal to the `enabled` preference and the
   * per-run `hidden` set — both survive being suppressed.
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

  private running(): RunView[] {
    return visibleWidgetRuns(this.manager.state.runs.values(), this.hidden);
  }

  private render(context: ExtensionContext): void {
    if (this.disposed) return;
    const running = this.enabled && !this.suppressed ? this.running() : [];
    if (running.length === 0) {
      this.stopTicking();
      context.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    this.startTicking();
    const now = Date.now();
    context.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      return new WidthAwareLines((width) => {
        const lines = running
          .slice(0, MAX_RUNS)
          .flatMap((run) => formatRunWidget(run, now, color, width));
        if (running.length > MAX_RUNS) {
          lines.push(
            color(
              "dim",
              `…+${running.length - MAX_RUNS} more (see /workflows)`,
            ),
          );
        }
        return lines;
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
    this.stopTicking();
  }
}
