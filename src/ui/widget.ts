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

/** Aggregate a path prefix: map/loop segments cover their whole subtree. */
function statusForPrefix(
  statuses: Map<string, PathStatus>,
  path: string,
): PathStatus | undefined {
  const exact = statuses.get(path);
  if (exact) return exact;
  let combined: PathStatus | undefined;
  for (const [key, status] of statuses) {
    if (!key.startsWith(`${path}.`)) continue;
    if (!combined) {
      combined = { ...status };
      continue;
    }
    combined.completed += status.completed;
    combined.total += status.total;
    combined.status =
      status.status === "running" || combined.status === "running"
        ? "running"
        : status.status === "failed" || combined.status === "failed"
          ? "failed"
          : combined.status;
    combined.error ??= status.error;
  }
  if (combined) {
    combined.detail =
      combined.total > 1
        ? `${combined.completed}/${combined.total}`
        : undefined;
  }
  return combined;
}

/** One segment per structural agent position, in flow order. */
export function widgetSegments(
  flow: FlowNode,
  statuses: Map<string, PathStatus>,
): WidgetSegment[] {
  const segments: WidgetSegment[] = [];
  const push = (path: string, text: string, extra?: string): void => {
    const status = statusForPrefix(statuses, path);
    const detail = status?.detail ? ` [${status.detail}]` : "";
    segments.push({
      text: `${text}${extra ?? ""}${detail}`,
      status: status?.status ?? "pending",
    });
  };
  const agentText = (node: Extract<FlowNode, { kind: "agent" }>): string =>
    node.as ? `${node.name} → {${node.as}}` : node.name;
  const visit = (node: FlowNode, path: string): void => {
    switch (node.kind) {
      case "agent":
        push(path, agentText(node));
        return;
      case "seq":
        node.steps.forEach((step, index) => {
          visit(step, stepPath(path, index));
        });
        return;
      case "par": {
        for (const [key, branch] of Object.entries(node.branches)) {
          if (branch.kind === "agent") {
            push(branchPath(path, key), `${key} → ${branch.name}`);
          } else {
            visit(branch, branchPath(path, key));
          }
        }
        if (node.reduce) {
          push(reducePath(path), `⑂reduce → ${node.reduce.agent}`);
        }
        return;
      }
      case "map":
        push(bodyPath(path), `⇶map ${node.over}`);
        if (node.reduce) {
          push(reducePath(path), `⑂reduce → ${node.reduce.agent}`);
        }
        return;
      case "loop":
        push(bodyPath(path), `↺loop`);
        return;
      case "workflow":
        if (node.body) visit(node.body, bodyPath(path));
        else push(path, `❖${node.name}`);
        return;
    }
  };
  visit(flow, "$");
  return segments;
}

/** Count agent-bearing leaves in the static skeleton (map/loop bodies once). */
function countStaticLeaves(node: FlowNode): number {
  switch (node.kind) {
    case "agent":
      return 1;
    case "seq":
      return node.steps.reduce((sum, step) => sum + countStaticLeaves(step), 0);
    case "par":
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

function formatElapsed(ms: number): string {
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

export class RunWidget {
  private readonly manager: RunManager;
  private lastContext: ExtensionContext | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(manager: RunManager) {
    this.manager = manager;
  }

  update(ctx?: ExtensionContext): void {
    const context = ctx ?? this.lastContext;
    if (!context?.hasUI) return;
    this.lastContext = context;
    this.render(context);
  }

  private running(): RunView[] {
    return [...this.manager.state.runs.values()].filter(
      (run) => run.status === "running",
    );
  }

  private render(context: ExtensionContext): void {
    const running = this.running();
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
