/**
 * Shared rendering helpers: the custom-message renderer for pi-agents output
 * and small formatting utilities used by commands and the tool.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SpawnUsage } from "../engine/types.js";
import type { RunSource } from "../run/events.js";
import type { NodeView, RunView } from "../run/state.js";
import { STATUS_STYLES } from "./status.js";

export const MESSAGE_TYPE = "pi-agents:message";

export const NOTIFICATION_TYPE = "pi-agents:notification";

interface RunNotificationBase {
  kind: "run_final";
  version: 2;
  runId: string;
  label?: string;
  usage?: string;
  agents: number;
  at: number;
}

/** Versioned display data for final-run notifications. Message content remains
 * the model-facing source of truth; these fields drive only the TUI card. */
export type RunNotificationDetails = RunNotificationBase &
  (
    | { status: "completed"; bodyKind: "result"; body: string }
    | { status: "failed"; bodyKind: "error"; body: string }
    | { status: "stopped"; bodyKind: "none"; body?: never }
  );

function messageText(message: { content: unknown }): string {
  return typeof message.content === "string"
    ? message.content
    : (message.content as Array<{ type?: string; text?: string }>)
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("\n");
}

function isRunNotificationDetails(
  value: unknown,
): value is RunNotificationDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  if (
    details.kind !== "run_final" ||
    details.version !== 2 ||
    typeof details.runId !== "string" ||
    (details.label !== undefined && typeof details.label !== "string") ||
    (details.usage !== undefined && typeof details.usage !== "string") ||
    typeof details.agents !== "number" ||
    typeof details.at !== "number"
  ) {
    return false;
  }
  switch (details.status) {
    case "completed":
      return details.bodyKind === "result" && typeof details.body === "string";
    case "failed":
      return details.bodyKind === "error" && typeof details.body === "string";
    case "stopped":
      return details.bodyKind === "none" && details.body === undefined;
    default:
      return false;
  }
}

export function formatAgentCount(agents: number): string {
  return `${agents} agent${agents === 1 ? "" : "s"}`;
}

export function formatRunNotificationControls(runId: string): string {
  const id = shortId(runId);
  return `Inspect: \`/workflow ${id}\` · full result: \`/workflow ${id} result\` · per-agent: \`/workflow ${id} agents\``;
}

const renderMarkdownMessage: MessageRenderer = (message) =>
  new Markdown(messageText(message), 1, 0, getMarkdownTheme());

/** Theme-aware TUI card for versioned notifications; older persisted details
 * deliberately fall back to their original Markdown content. */
export const renderRunNotification: MessageRenderer = (
  message,
  _options,
  theme,
) => {
  const details = message.details;
  if (!isRunNotificationDetails(details))
    return renderMarkdownMessage(message, _options, theme);

  const id = shortId(details.runId);
  const status = STATUS_STYLES[details.status];
  const identity = details.label
    ? `${theme.bold(details.label)}${theme.fg("dim", ` · ${id} · `)}`
    : theme.fg("dim", `${id} · `);
  const usage = details.usage
    ? theme.fg(
        "dim",
        ` · ${details.usage} · ${formatAgentCount(details.agents)}`,
      )
    : "";
  const header = `${theme.fg("muted", "❖")} ${identity}${theme.fg(status.color, `${status.icon} ${details.status}`)}${usage}`;

  // Keep this renderer pure: the host re-invokes it with the current theme
  // whenever the transcript is invalidated.
  const card = new Container();
  card.addChild(new Text(header, 1, 0));
  card.addChild(new Spacer(1));
  card.addChild(
    new Markdown(
      formatRunNotificationControls(details.runId),
      1,
      0,
      getMarkdownTheme(),
    ),
  );
  if (details.bodyKind !== "none" && details.body !== undefined) {
    card.addChild(new Spacer(1));
    card.addChild(new Markdown(details.body, 1, 0, getMarkdownTheme()));
  }
  return card;
};

export function registerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(MESSAGE_TYPE, renderMarkdownMessage);
  pi.registerMessageRenderer(NOTIFICATION_TYPE, renderRunNotification);
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

/** Let Pi render string results as Markdown; keep structured values literal. */
export function renderResultValue(value: unknown, text: string): string {
  return typeof value === "string" ? text : fenced(text);
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
  const icon = STATUS_STYLES[run.status].icon;
  const label =
    run.header.label ?? run.header.source.workflow ?? run.header.flow.kind;
  const source = formatRunSource(run.header.source);
  const usage = formatUsage(run.usage);
  return `${icon} ${shortId(run.header.id)}  ${run.status.padEnd(9)} ${label} (${source})${usage ? `  ${usage}` : ""}`;
}
