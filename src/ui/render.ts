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

/** Indented textual tree of a run's node instances, in first-seen order. */
export function formatRunTree(run: RunView): string {
  const lines: string[] = [];
  for (const instance of run.order) {
    const node = run.nodes.get(instance);
    if (!node) continue;
    lines.push(formatNodeLine(node));
  }
  return lines.join("\n");
}

function formatNodeLine(node: NodeView): string {
  const depth = instanceDepth(node.instance);
  const indent = "  ".repeat(depth);
  const icon = STATUS_ICONS[node.status] ?? "?";
  const what =
    node.kind === "agent" || node.kind === "reduce"
      ? `${node.kind === "reduce" ? "reduce → " : ""}${node.agent ?? "?"}`
      : node.kind;
  const suffix =
    node.status === "failed" && node.error
      ? ` — ${node.error.split("\n")[0]}`
      : node.status === "cancelled" && node.cancelReason
        ? ` — cancelled (${node.cancelReason})`
        : "";
  const usage = node.usage ? ` [${formatUsage(node.usage)}]` : "";
  return `${indent}${icon} ${labelOf(node)}${what !== node.label ? ` ${what}` : ""}${usage}${suffix}`;
}

function labelOf(node: NodeView): string {
  if (node.label) return `${node.label}:`;
  const tail = node.instance.replace(/^\$\.?/, "");
  return tail ? `${tail}:` : "";
}

function instanceDepth(instance: string): number {
  if (instance === "$") return 0;
  return instance.replace(/^\$\.?/, "").split(".").length;
}

export function formatRunOverviewLine(run: RunView): string {
  const icon = STATUS_ICONS[run.status] ?? "?";
  const label =
    run.header.label ?? run.header.source.workflow ?? run.header.flow.kind;
  const source =
    run.header.source.kind === "hook"
      ? `hook:${run.header.source.event ?? "?"}`
      : run.header.source.kind;
  const usage = formatUsage(run.usage);
  return `${icon} ${shortId(run.header.id)}  ${run.status.padEnd(9)} ${label} (${source})${usage ? `  ${usage}` : ""}`;
}
