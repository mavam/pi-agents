/**
 * Shared rendering helpers: the custom-message renderer for pi-agents output
 * and small formatting utilities used by commands and the tool.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SpawnUsage } from "../engine/types.js";
import { resolvePath } from "../model/interpolate.js";
import { parseFlowNode } from "../model/validate.js";
import { valueText } from "../model/value.js";
import type { RunSource, RunStatus } from "../run/events.js";
import type { NodeView, RunView } from "../run/state.js";
import { STATUS_STYLES } from "./status.js";
import { KIND_ICONS, renderFlowTree } from "./tree.js";

export const MESSAGE_TYPE = "pi-agents:message";

export const NOTIFICATION_TYPE = "pi-agents:notification";

interface RunNotificationBase {
  kind: "run_final";
  version: 2;
  runId: string;
  label?: string;
  usage?: string;
  agents: number;
  /** Earlier version-2 notifications omit this and are treated as not copyable. */
  copyable?: boolean;
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
    (details.copyable !== undefined && typeof details.copyable !== "boolean") ||
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

/**
 * Compact control bar for a finished run. The workflow glyph marks the line
 * as injected UI chrome, and the bracketed suffixes advertise the real
 * `/workflow` sub-commands. Without a theme the command is wrapped in a code
 * span so it stays copy-pasteable in Markdown; with a theme the whole line
 * renders dim for a TUI card.
 */
export function formatRunNotificationControls(
  runId: string,
  copyable: boolean,
  theme?: Theme,
): string {
  const command = `/workflow ${shortId(runId)}`;
  const actions = copyable ? "copy|result|raw|agents" : "result|raw|agents";
  if (!theme) return `${KIND_ICONS.workflow} \`${command}\` [${actions}]`;
  return `${theme.fg("muted", KIND_ICONS.workflow)} ${theme.fg(
    "dim",
    `${command} [${actions}]`,
  )}`;
}

/** Minimal color hook so workflow previews stay testable without a theme. */
export type WorkflowPreviewColorize = (
  color: "dim" | "accent" | "success" | "warning" | "error" | "muted",
  text: string,
) => string;

const plainPreview: WorkflowPreviewColorize = (_color, text) => text;
const PARAM_PREVIEW_CHARS = 72;

/** Inputs shared by model tool calls and direct saved-workflow commands. */
export interface WorkflowCallPreview {
  name?: string;
  params?: Record<string, string>;
  flow?: unknown;
  label?: string;
}

/** Mutable state used only while an inline tool call streams its arguments. */
export interface WorkflowPreviewState {
  lastValidFlowTree?: string;
  savedFlowTree?: string | null;
  callText?: string;
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Render a workflow invocation consistently for tool calls and slash commands.
 * Saved workflows supply their already-expanded tree, including its workflow
 * root; inline tool calls parse the partial flow and retain the newest valid
 * tree while arguments stream.
 */
export function formatWorkflowCallPreview(
  params: WorkflowCallPreview,
  color: WorkflowPreviewColorize = plainPreview,
  savedFlowTree?: string,
  streamingState?: WorkflowPreviewState,
): string {
  const lines: string[] = [];
  const label = params.label ? color("dim", ` · ${params.label}`) : "";
  try {
    if (params.name !== undefined) {
      // Render the invocation-specific title ourselves, then keep the rooted
      // tree's children. This preserves labels and parameter previews while
      // making every flow node a visible child of the workflow title.
      const flowChildren = savedFlowTree
        ? savedFlowTree.split("\n").slice(1)
        : [];
      lines.push(
        `${color("muted", KIND_ICONS.workflow)} ${params.name}${label}`,
      );
      const paramPrefix = flowChildren.length > 0 ? "│  " : "   ";
      for (const [key, value] of Object.entries(params.params ?? {})) {
        lines.push(
          color(
            "dim",
            `${paramPrefix}${key}: ${oneLine(value, PARAM_PREVIEW_CHARS)}`,
          ),
        );
      }
      lines.push(...flowChildren);
    } else if (params.flow !== undefined) {
      if (params.label) lines.push(color("dim", params.label));
      const issues: { path: string; message: string }[] = [];
      const parsed = parseFlowNode(params.flow, "$", issues);
      if (parsed && issues.length === 0) {
        const tree = renderFlowTree(parsed, color);
        if (streamingState) streamingState.lastValidFlowTree = tree;
        lines.push(tree);
      } else if (streamingState?.lastValidFlowTree) {
        lines.push(streamingState.lastValidFlowTree);
      } else if (!streamingState) {
        lines.push(`${JSON.stringify(params.flow)?.slice(0, 200) ?? ""}…`);
      }
    }
  } catch {
    // Streaming args may be incomplete; the caller supplies a stable fallback.
  }
  return lines.join("\n");
}

export interface WorkflowResultPreviewDetails {
  runId: string;
  status: RunStatus;
  error?: string;
}

/** Render the metadata below a workflow invocation or completed tool call. */
export function formatWorkflowResultPreview(
  result: { details: WorkflowResultPreviewDetails; text: string },
  expanded: boolean,
  color: WorkflowPreviewColorize = plainPreview,
): string {
  const { runId, status, error } = result.details;
  const id = shortId(runId);
  if (status === "running") {
    return `\n${color("dim", `running in background · /workflow ${id}`)}`;
  }
  if (status === "completed") {
    const presentation = STATUS_STYLES.completed;
    const head = `\n${color(presentation.color, presentation.icon)} completed ${color("dim", `· /workflow ${id} result`)}`;
    return expanded ? `${head}\n${result.text}` : head;
  }
  const presentation = STATUS_STYLES[status];
  const head = `\n${color(presentation.color, presentation.icon)} ${status}${error ? ` ${color("dim", `— ${oneLine(error, 120)}`)}` : ""} ${color("dim", `· /workflow ${id}`)}`;
  return expanded ? `${head}\n${result.text}` : head;
}

/** Complete start message for direct slash-command invocations. */
export function formatWorkflowStartPreview(
  call: WorkflowCallPreview,
  runId: string,
  savedFlowTree: string,
  color: WorkflowPreviewColorize = plainPreview,
): string {
  const preview =
    formatWorkflowCallPreview(call, color, savedFlowTree) || "workflow";
  const result = formatWorkflowResultPreview(
    { details: { runId, status: "running" }, text: "" },
    false,
    color,
  );
  // The result formatter starts with one newline because tool calls render it
  // in a separate component. Add another here to preserve the same gap when
  // both slots share one command message.
  return `${preview}\n${result}`;
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
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  card.addChild(new Text(header, 0, 0));
  if (details.bodyKind !== "none" && details.body !== undefined) {
    card.addChild(new Spacer(1));
    card.addChild(new Markdown(details.body, 0, 0, getMarkdownTheme()));
  }
  card.addChild(new Spacer(1));
  card.addChild(
    new Text(
      formatRunNotificationControls(
        details.runId,
        details.copyable === true,
        theme,
      ),
      0,
      0,
    ),
  );
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
  const text = valueText(value) ?? "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export interface SelectedDisplayValue {
  /** The declared Markdown string, or the original value as a fallback. */
  value: unknown;
  /** Whether the declared path resolved to a string. */
  selected: boolean;
  /** Why a declared path fell back to the raw value. */
  warning?: string;
}

/** Select a run's declared human-facing Markdown result. */
export function selectDisplayValue(
  value: unknown,
  display: string | undefined,
): SelectedDisplayValue {
  if (!display) return { value, selected: false };
  const resolved = resolvePath(value, display.split("."));
  if (!resolved.found) {
    return {
      value,
      selected: false,
      warning: `Display path \`${display}\` was not found; showing the raw result.`,
    };
  }
  if (typeof resolved.value !== "string") {
    return {
      value,
      selected: false,
      warning: `Display path \`${display}\` resolved to a non-string value; showing the raw result.`,
    };
  }
  return { value: resolved.value, selected: true };
}

/** Wrap text in a code fence long enough to contain embedded backticks. */
export function fenced(text: string, language?: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language ?? ""}\n${text}\n${fence}`;
}

/** Let Pi render string results as Markdown; highlight structured values as JSON. */
export function renderResultValue(value: unknown, text: string): string {
  return typeof value === "string" ? text : fenced(text, "json");
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
