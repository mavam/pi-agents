/**
 * The above-editor widget for live runs: two lines per run.
 *
 *   ⠸ ▰▰▰▰▰▰▰▱▱▱ 67%  review · c9e5799 · 1m32s · 15.5k tok
 *      ● bugs→reviewer   ● clarity→reviewer   ◉ ⑂reduce→worker
 *
 * Line 1: braille spinner, parallelogram completion bar (done agents over
 * known agents — the denominator grows as map items are discovered), label,
 * dim id, elapsed, live token count (completed usage + streaming usage).
 * Line 2: one status-iconed segment per structural agent position.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { SpawnUsage } from "../engine/types.js";
import {
  ADHOC_LABEL,
  bodyPath,
  branchPath,
  type FlowNode,
  reducePath,
  stepPath,
} from "../model/ast.js";
import type { RunManager } from "../run/runs.js";
import type { RunView } from "../run/state.js";
import { formatTokens, shortId } from "./render.js";
import { aggregateStatuses, type PathStatus } from "./tree.js";

const WIDGET_KEY = "pi-agents:runs";
const MAX_RUNS = 4;
const MAX_SEGMENTS = 5;
const TICK_MS = 200;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type SegmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

const SEGMENT_ICONS: Record<SegmentStatus, string> = {
  pending: "○",
  running: "◉",
  completed: "●",
  failed: "✗",
  cancelled: "⊘",
};

export interface WidgetSegment {
  text: string;
  status: SegmentStatus;
}

/** Colors used by the widget; the identity function makes it testable. */
export type Colorize = (
  color: "success" | "accent" | "muted" | "dim" | "error" | "text",
  text: string,
) => string;

export const plainColorize: Colorize = (_color, text) => text;

/** Widget lines truncated to the terminal width (ANSI-aware), never wrapped. */
class TruncatedLines implements Component {
  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  invalidate(): void {
    // Content is immutable; the widget is replaced wholesale on updates.
  }

  render(width: number): string[] {
    const usable = Math.max(4, width - 1);
    return this.lines.map((line) => ` ${truncateToWidth(line, usable)}`);
  }
}

/**
 * Status for one depth-1 unit: liveness from the unit's own node (when it
 * has started), work counts aggregated over the agent/reduce paths in its
 * subtree — so `⑃ parallel [2/4]` counts agents, not structural nodes.
 */
function unitStatus(
  statuses: Map<string, PathStatus>,
  path: string,
): { status: SegmentStatus; detail?: string } {
  const own = statuses.get(path);
  let completed = 0;
  let total = 0;
  let running = 0;
  let failed = 0;
  for (const [key, status] of statuses) {
    if (key !== path && !key.startsWith(`${path}.`)) continue;
    if (status.kind !== "agent" && status.kind !== "reduce") continue;
    completed += status.completed;
    total += status.total;
    if (status.status === "running") running += 1;
    if (status.status === "failed") failed += 1;
  }
  const derived: SegmentStatus | undefined =
    total > 0
      ? running > 0
        ? "running"
        : failed > 0
          ? "failed"
          : "completed"
      : undefined;
  return {
    status: own?.status ?? derived ?? "pending",
    detail: total > 1 ? `${completed}/${total}` : undefined,
  };
}

/**
 * One segment per depth-1 unit. The tool-call box carries the full vertical
 * structure; the widget summarizes horizontally: a sequence root yields one
 * segment per top-level step, a parallel root one per branch (plus reduce), and
 * composite units collapse to their kind glyph with aggregate counts.
 */
export function widgetSegments(
  flow: FlowNode,
  statuses: Map<string, PathStatus>,
): WidgetSegment[] {
  const segments: WidgetSegment[] = [];
  const push = (path: string, text: string): void => {
    const { status, detail } = unitStatus(statuses, path);
    segments.push({
      text: `${text}${detail ? ` [${detail}]` : ""}`,
      status,
    });
  };
  const agentText = (node: Extract<FlowNode, { kind: "agent" }>): string => {
    const name = node.name ?? ADHOC_LABEL;
    return node.as ? `${name} → {${node.as}}` : name;
  };

  /** Summarize any node as one collapsed segment. */
  const unit = (node: FlowNode, path: string, prefix = ""): void => {
    switch (node.kind) {
      case "agent":
        push(
          path,
          `${prefix}${prefix ? (node.name ?? ADHOC_LABEL) : agentText(node)}`,
        );
        return;
      case "sequence":
        push(path, `${prefix}≡ ${node.label ?? "sequence"}`);
        return;
      case "parallel":
        push(path, `${prefix}⑃ ${node.label ?? "parallel"}`);
        return;
      case "map":
        push(path, `${prefix}⇶ map ${node.over}`);
        return;
      case "loop":
        push(path, `${prefix}↺ loop`);
        return;
      case "workflow":
        push(path, `${prefix}❖ ${node.name}`);
        return;
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
    root.steps.forEach((step, index) => {
      unit(step, stepPath(rootPath, index));
    });
  } else if (root.kind === "parallel") {
    for (const [key, branch] of Object.entries(root.branches)) {
      if (branch.kind === "agent") {
        push(
          branchPath(rootPath, key),
          `${key} → ${branch.name ?? ADHOC_LABEL}`,
        );
      } else {
        unit(branch, branchPath(rootPath, key), `${key} `);
      }
    }
    if (root.reduce) {
      push(
        reducePath(rootPath),
        `⑂ reduce → ${root.reduce.agent ?? ADHOC_LABEL}`,
      );
    }
  } else {
    unit(root, rootPath);
  }
  return segments;
}

/** Count agent-bearing leaves in the static skeleton (map/loop bodies once). */
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
      return countStaticLeaves(node.body);
    case "workflow":
      return node.body ? countStaticLeaves(node.body) : 1;
  }
}

/** Completion over known agents: seen instances plus unstarted skeleton leaves. */
export function widgetProgress(run: RunView): { done: number; total: number } {
  const agentNodes = [...run.nodes.values()].filter(
    (node) => node.kind === "agent" || node.kind === "reduce",
  );
  const done = agentNodes.filter((node) => node.status === "completed").length;
  const seenPaths = new Set(agentNodes.map((node) => node.path)).size;
  const unstarted = Math.max(0, countStaticLeaves(run.header.flow) - seenPaths);
  return { done, total: agentNodes.length + unstarted };
}

function liveTokens(run: RunView): number {
  let total = 0;
  for (const node of run.nodes.values()) {
    const usage: SpawnUsage | undefined =
      node.usage ??
      (node.status === "running" ? node.progressUsage : undefined);
    if (usage) total += usage.input + usage.output;
  }
  return total;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function segmentColor(status: SegmentStatus): Parameters<Colorize>[0] {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "accent";
    case "failed":
      return "error";
    default:
      return "dim";
  }
}

/** Latest output line of the most recently started running agent. */
function liveExcerpt(run: RunView): string | undefined {
  let best: { startedAt: number; text: string } | undefined;
  for (const node of run.nodes.values()) {
    if (node.status !== "running" || !node.progressText) continue;
    if (!best || node.startedAt > best.startedAt) {
      best = { startedAt: node.startedAt, text: node.progressText };
    }
  }
  const line = best?.text.split("\n").find((part) => part.trim());
  return line?.trim();
}

/**
 * The two widget lines for one run. Pure — testable with plainColorize.
 * Lines are truncated to the terminal width at render time (ANSI-aware).
 */
export function formatRunWidget(
  run: RunView,
  now: number,
  frame: number,
  color: Colorize = plainColorize,
): string[] {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string;
  const { done, total } = widgetProgress(run);
  const ratio = total > 0 ? done / total : 0;
  const percent = `${Math.round(ratio * 100)}%`;
  const label = run.header.label ?? run.header.flow.kind;
  const tokens = liveTokens(run);
  const dot = color("dim", " · ");
  const meta = [
    shortId(run.header.id),
    formatElapsed(now - run.createdAt),
    tokens > 0 ? formatTokens(tokens) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .map((part) => color("dim", part))
    .join(dot);
  const excerpt = liveExcerpt(run);

  const statuses = aggregateStatuses(run);
  const segments = widgetSegments(run.header.flow, statuses);
  const shown = segments.slice(0, MAX_SEGMENTS);
  const overflow = segments.length - shown.length;
  const segmentText = shown
    .map((segment) => {
      const icon = color(
        segmentColor(segment.status),
        SEGMENT_ICONS[segment.status],
      );
      const text =
        segment.status === "running"
          ? segment.text
          : color("muted", segment.text);
      return `${icon} ${text}`;
    })
    .join("   ");

  return [
    `${color("accent", spinner)} ${percent}${dot}${label}${dot}${meta}${excerpt ? `${dot}${color("dim", excerpt)}` : ""}`,
    `  ${segmentText}${overflow > 0 ? color("dim", `   …+${overflow}`) : ""}`,
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
  private frame = 0;
  /** Run ids muted from the summary (session-scoped, via the /runs overlay `h`). */
  private readonly hidden = new Set<string>();
  private enabled = true;

  constructor(manager: RunManager) {
    this.manager = manager;
  }

  update(ctx?: ExtensionContext): void {
    const context = ctx ?? this.lastContext;
    if (!context?.hasUI) return;
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
    const running = this.enabled ? this.running() : [];
    if (running.length === 0) {
      this.stopTicking();
      context.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    this.startTicking();
    const now = Date.now();
    const frame = this.frame;
    context.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      const lines = running
        .slice(0, MAX_RUNS)
        .flatMap((run) => formatRunWidget(run, now, frame, color));
      if (running.length > MAX_RUNS) {
        lines.push(
          color("dim", `…+${running.length - MAX_RUNS} more (see /runs)`),
        );
      }
      return new TruncatedLines(lines);
    });
  }

  private startTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame += 1;
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

  /** Stop the animation timer (session shutdown). */
  dispose(): void {
    this.stopTicking();
  }
}
