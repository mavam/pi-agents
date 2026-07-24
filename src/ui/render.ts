/**
 * Shared rendering helpers: the custom-message renderer for pi-agents output
 * and small formatting utilities used by commands and the tool.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type { SpawnUsage } from "../engine/types.js";
import type { RunSource } from "../run/events.js";
import type { NodeView, RunView } from "../run/state.js";

export const MESSAGE_TYPE = "pi-agents:message";

export const NOTIFICATION_TYPE = "pi-agents:notification";

export function registerRenderers(pi: ExtensionAPI): void {
  const renderMarkdown = (message: { content: unknown }) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ type?: string; text?: string }>)
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("\n");
    return new Markdown(text, 1, 0, getMarkdownTheme());
  };
  pi.registerMessageRenderer(MESSAGE_TYPE, renderMarkdown);
  pi.registerMessageRenderer(NOTIFICATION_TYPE, renderMarkdown);
}

export function sendInfo(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true });
}

export function shortId(runId: string): string {
  return runId.slice(0, 8);
}

export function formatRunSource(source: RunSource): string {
  if (source.kind === "hook") return `hook:${source.event ?? "?"}`;
  if (source.kind === "rpc")
    return source.caller ? `rpc:${source.caller}` : "rpc";
  return source.kind;
}

export function formatUsage(usage: SpawnUsage | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.turns > 0)
    parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input > 0 || usage.output > 0)
    parts.push(`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`);
  if (usage.cost > 0)
    parts.push(`$${usage.cost.toFixed(usage.cost < 0.1 ? 4 : 2)}`);
  return parts.join(" ");
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export const STATUS_ICONS: Record<string, string> = {
  running: "◉",
  completed: "●",
  failed: "✗",
  cancelled: "⊘",
  stopped: "⊘",
};

export function formatValuePreview(value: unknown, maxChars = 400): string {
  if (value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** Wrap text in a code fence long enough to contain embedded backticks. */
export function fenced(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Short human name for a node instance path: `$.branches.bugs` → `bugs`,
 * `$.reduce` → `reduce`, `$.body@2` → `@2`, `$.steps[1].body#3` → `2#3`,
 * `$.cases[0].then` → `case 1`, `$.else` → `else`.
 * A bare-agent root (`$`) falls back to the label, agent name, or kind.
 */
export function nodeDisplayName(
  node: Pick<NodeView, "instance" | "label" | "agent" | "kind">,
): string {
  const name = node.instance
    .replace(/^\$/, "")
    .replaceAll(".branches.", ".")
    .replaceAll(/\.steps\[(\d+)\]/g, (_, index) => `.${Number(index) + 1}`)
    .replaceAll(
      /\.cases\[(\d+)\]\.then/g,
      (_, index) => `.case ${Number(index) + 1}`,
    )
    .replaceAll(".body", "")
    .replace(/^\./, "");
  return name || (node.label ?? node.agent ?? node.kind);
}

export function formatRunOverviewLine(run: RunView): string {
  const icon = STATUS_ICONS[run.status] ?? "?";
  const label =
    run.header.label ?? run.header.source.workflow ?? run.header.flow.kind;
  const source = formatRunSource(run.header.source);
  const usage = formatUsage(run.usage);
  return `${icon} ${shortId(run.header.id)}  ${run.status.padEnd(9)} ${label} (${source})${usage ? `  ${usage}` : ""}`;
}
