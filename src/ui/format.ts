/**
 * Shared formatting: colors, status icons, durations, usage, and one-line
 * agent summaries for the panel, the overlay, and tool rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  type AgentInfo,
  type AgentState,
  type AgentUsage,
  formatModelRef,
} from "../agents/types.js";

export type Colorize = (
  color: "success" | "accent" | "warning" | "muted" | "dim" | "error" | "text",
  text: string,
) => string;

export const plainColorize: Colorize = (_color, text) => text;

/** The status vocabulary shared by every surface. */
export const STATE_STYLES = {
  working: { icon: "◉", color: "warning" },
  idle: { icon: "●", color: "success" },
  failed: { icon: "✗", color: "error" },
  stopped: { icon: "⊘", color: "dim" },
} as const satisfies Record<
  AgentState,
  { icon: string; color: Parameters<Colorize>[0] }
>;

export const AGENT_ICON = "✦";

/** A working agent counts as silent after this much time without progress. */
export const STALL_AFTER_MS = 60_000;

export function stateIcon(state: AgentState, color: Colorize): string {
  const style = STATE_STYLES[state];
  return color(style.color, style.icon);
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

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatCost(cost: number): string {
  if (cost <= 0) return "";
  return `$${cost.toFixed(cost < 0.1 ? 3 : 2)}`;
}

export function totalTokens(usage: AgentUsage): number {
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
export function activityText(info: AgentInfo, now: number): string | undefined {
  if (info.state !== "working") return undefined;
  const silent = now - info.lastActivityAt;
  if (silent >= STALL_AFTER_MS)
    return `no activity for ${formatElapsed(silent)}`;
  const { activity } = info;
  if (activity.retry) return `retrying: ${activity.retry}`;
  if (activity.compacting) return "compacting";
  if (activity.tool) return `Using ${activity.tool}`;
  return activity.summary;
}

/**
 * One agent line for the panel; the glyph carries the state:
 * `◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep`.
 */
export function formatAgentLine(
  info: AgentInfo,
  now: number,
  color: Colorize = plainColorize,
  modelLabel?: string,
): string {
  const usage = formatUsage(info.usage);
  const activity =
    activityText(info, now) ??
    (info.state === "failed" ? info.result?.errorMessage : undefined);
  const dot = color("dim", " · ");
  return [
    `${stateIcon(info.state, color)} ${info.name}`,
    info.profile ? color("dim", info.profile) : undefined,
    color("dim", modelLabel ?? shortModel(info)),
    color("dim", formatElapsed(now - info.stateSince)),
    usage ? color("dim", usage) : undefined,
    activity
      ? color(info.state === "failed" ? "error" : "dim", oneLine(activity, 120))
      : undefined,
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
