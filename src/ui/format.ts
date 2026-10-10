/**
 * Shared formatting: colors, status icons, durations, usage, and one-line
 * agent summaries for the panel, the overlay, and tool rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { shapeLine } from "../agents/topology.js";
import {
  type AgentInfo,
  type AgentState,
  type AgentUsage,
  formatModelRef,
  type GraphInfo,
} from "../agents/types.js";

export type Colorize = (
  color: "success" | "accent" | "warning" | "muted" | "dim" | "error" | "text",
  text: string,
) => string;

export const plainColorize: Colorize = (_color, text) => text;

/** The status vocabulary shared by every surface. */
export const STATE_STYLES = {
  working: { icon: "◉", color: "warning" },
  waiting: { icon: "○", color: "dim" },
  idle: { icon: "●", color: "success" },
  failed: { icon: "✗", color: "error" },
  interrupted: { icon: "⊘", color: "dim" },
  skipped: { icon: "⊖", color: "muted" },
} as const satisfies Record<
  AgentState,
  { icon: string; color: Parameters<Colorize>[0] }
>;

/** What a call's wait gave up on before it finished: the call's outcome
 * for it, which stays true. */
export const WAIT_ENDED_STYLE = { icon: "⊠", color: "warning" } as const;

/** An answer that waits for the parent: idle, but not done yet. */
export const QUEUED_STYLE = { icon: "●", color: "accent" } as const;

/** The note on agents and graphs whose result waits for the parent. */
export const QUEUED_NOTE = "result queued";

export const AGENT_ICON = "✦";

/** A working agent counts as silent after this much time without progress. */
const STALL_AFTER_MS = 60_000;

export function stateIcon(state: AgentState, color: Colorize): string {
  const style = STATE_STYLES[state];
  return color(style.color, style.icon);
}

/** The glyph of an agent or a graph; an idle one with a queued result
 * differs from one whose result reached the parent. */
export function statusIcon(
  item: { state: AgentState; queued?: boolean },
  color: Colorize,
): string {
  if (item.queued && item.state === "idle")
    return color(QUEUED_STYLE.color, QUEUED_STYLE.icon);
  return stateIcon(item.state, color);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * How long an agent or graph ran: from its creation until now while it works
 * or waits for its inputs, else until it ended, so a finished one's clock
 * stops. A resumed agent's clock jumps forward to include the pause.
 */
export function runtime(
  item: Pick<AgentInfo, "state" | "createdAt" | "stateSince" | "endedAt">,
  now: number,
): number {
  const end =
    item.state === "working" || item.state === "waiting"
      ? now
      : (item.endedAt ?? item.stateSince);
  return Math.max(0, end - item.createdAt);
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatCost(cost: number): string {
  if (cost <= 0) return "";
  return `$${cost.toFixed(cost < 0.1 ? 3 : 2)}`;
}

function totalTokens(usage: AgentUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** `15.5k · $0.04`, or empty without usage. */
export function formatUsage(usage: AgentUsage): string {
  const tokens = totalTokens(usage);
  return [tokens > 0 ? formatTokens(tokens) : "", formatCost(usage.cost)]
    .filter(Boolean)
    .join(" · ");
}

export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The provider-less model ID, the compact form for lines. */
export function shortModel(info: Pick<AgentInfo, "model">): string {
  return info.model?.modelId ?? formatModelRef(info.model);
}

/** What the agent is doing right now, for working agents. */
function activityText(info: AgentInfo, now: number): string | undefined {
  if (info.state !== "working") return undefined;
  const silent = now - info.lastActivityAt;
  if (silent >= STALL_AFTER_MS)
    return `no activity for ${formatElapsed(silent)}`;
  const { activity } = info;
  if (activity.retry) return `retrying: ${activity.retry}`;
  if (activity.delegation)
    return `delegating · ${shortName(activity.delegation.graph, info.name)} ${activity.delegation.done}/${activity.delegation.total}`;
  if (activity.compacting) return "compacting";
  if (activity.tool) return `Using ${activity.tool}`;
  return activity.summary;
}

/**
 * One agent line for the panel and tool results; the glyph carries the state
 * and working agents show how long they have worked:
 * `◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep`. An idle
 * agent whose answer waits for the parent shows `●` in the accent color and
 * `result queued`.
 */
export function formatAgentLine(
  info: AgentInfo,
  now: number,
  color: Colorize = plainColorize,
  /** Names of the agents whose results it receives, in a graph. */
  inputs: readonly string[] = [],
): string {
  const usage = formatUsage(info.usage);
  const activity =
    activityText(info, now) ??
    (info.state === "failed" ? info.result?.errorMessage : undefined) ??
    (info.queued ? QUEUED_NOTE : undefined);
  const dot = color("dim", " · ");
  const from = inputs.length > 0 ? color("dim", ` ← ${inputs.join(", ")}`) : "";
  return [
    `${statusIcon(info, color)} ${info.name}${from}`,
    info.profile ? color("dim", info.profile) : undefined,
    color("dim", shortModel(info)),
    info.state === "working"
      ? color("dim", formatElapsed(runtime(info, now)))
      : undefined,
    usage ? color("dim", usage) : undefined,
    activity
      ? color(info.state === "failed" ? "error" : "dim", oneLine(activity, 120))
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(dot);
}

/**
 * A helper's name without its agent's: `agents-review.derive` reads as
 * `derive` below `agents-review`. Other names stay as they are.
 */
export function shortName(name: string, owner: string | undefined): string {
  return owner !== undefined && name.startsWith(`${owner}.`)
    ? name.slice(owner.length + 1)
    : name;
}

/** `1 failed, 2 stopped`: how many of a finished graph's agents did not
 * answer. */
export function graphNote(graph: GraphInfo): string | undefined {
  if (graph.state === "working") return undefined;
  if (graph.stopped) return "stopped";
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    const kind = node.outcome?.kind ?? "failed";
    if (kind !== "answered") counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const note = ["failed", "interrupted", "stopped", "skipped"]
    .flatMap((kind) => {
      const count = counts.get(kind);
      return count ? [`${count} ${kind}`] : [];
    })
    .join(", ");
  return note || undefined;
}

/** `map → {api, tests} → merge`: the graph's stages by agent name. */
export function graphShape(graph: Pick<GraphInfo, "nodes">): string {
  const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
  return shapeLine(
    graph.nodes.map((node) => ({ key: node.agentId, inputs: node.inputs })),
    (key) => names.get(key) ?? key,
  );
}

/**
 * One graph line: the glyph carries the graph's state, then how many agents
 * finished, the elapsed time while working, the summed usage, and how many
 * did not answer: `◉ review · graph 1/3 · 1m32s · 31.5k`. A finished graph
 * whose result waits for the parent says so.
 */
export function formatGraphLine(
  graph: GraphInfo,
  now: number,
  color: Colorize = plainColorize,
): string {
  const done = graph.nodes.filter((node) => node.outcome).length;
  const usage = formatUsage(graph.usage);
  const note = graphNote(graph);
  const dot = color("dim", " · ");
  return [
    `${statusIcon(graph, color)} ${graph.name}`,
    color("dim", `graph ${done}/${graph.nodes.length}`),
    graph.state === "working"
      ? color("dim", formatElapsed(runtime(graph, now)))
      : undefined,
    usage ? color("dim", usage) : undefined,
    note ? color(graph.state === "failed" ? "error" : "dim", note) : undefined,
    graph.queued ? color("dim", QUEUED_NOTE) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(dot);
}

/**
 * Neutralize characters that can desynchronize or control the terminal.
 * Preserve only CSI SGR sequences produced by Pi's theme renderers. Strip
 * cursor movement, screen control, OSC/DCS/APC strings, malformed escapes,
 * tabs, and remaining C0/C1 controls from agent-provided output.
 */
export function sanitizeLine(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code === 0x1b) {
      const next = line[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < line.length) {
          const value = line.charCodeAt(end);
          if (value >= 0x40 && value <= 0x7e) break;
          if (value < 0x20 || value > 0x3f) break;
          end += 1;
        }
        if (end < line.length) {
          const final = line.charCodeAt(end);
          if (final >= 0x40 && final <= 0x7e) {
            if (line[end] === "m") result += line.slice(index, end + 1);
            index = end + 1;
            continue;
          }
        }
        // An unterminated or malformed CSI owns the rest of this line.
        break;
      }
      if (next && "]P^_X".includes(next)) {
        const stringStart = index + 2;
        const stringTerminator = line.indexOf("\u001b\\", stringStart);
        const bellTerminator =
          next === "]" ? line.indexOf("\u0007", stringStart) : -1;
        const terminators = [stringTerminator, bellTerminator].filter(
          (value) => value >= 0,
        );
        if (terminators.length === 0) break;
        const terminator = Math.min(...terminators);
        index = terminator + (terminator === bellTerminator ? 1 : 2);
        continue;
      }
      // Other ESC sequences are two-byte terminal controls; a lone ESC is
      // discarded as well.
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (code === 0x09) {
      result += "  ";
      index += 1;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    result += line[index];
    index += 1;
  }
  return result;
}

/** Sanitize and fit a line to `width`. */
export function fitLine(line: string, width: number): string {
  return truncateToWidth(sanitizeLine(line), Math.max(1, width), "…");
}
