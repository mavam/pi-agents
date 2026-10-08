/**
 * Agent results posted into the parent conversation: the model-facing text
 * and the TUI card.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentInfo, PendingDelivery } from "../agents/types.js";
import {
  type Colorize,
  formatUsage,
  plainColorize,
  STATE_STYLES,
  shortModel,
} from "../ui/format.js";

export const RESULT_MESSAGE = "pi-agents:result";

/** Lines of a collapsed result body. */
const COLLAPSED_LINES = 12;

export interface ResultDetails {
  version: 1;
  agentId: string;
  name: string;
  kind: "answered" | "failed";
  /** The result text, or the failure reason. */
  body: string;
  profile?: string;
  model?: string;
  usage?: string;
}

export function isResultDetails(value: unknown): value is ResultDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return (
    details.version === 1 &&
    typeof details.agentId === "string" &&
    typeof details.name === "string" &&
    (details.kind === "answered" || details.kind === "failed") &&
    typeof details.body === "string"
  );
}

export function resultDetails(
  delivery: PendingDelivery,
  info: AgentInfo | undefined,
): ResultDetails {
  const { outcome } = delivery;
  const usage = info ? formatUsage(info.usage) : "";
  return {
    version: 1,
    agentId: delivery.agentId,
    name: delivery.name,
    kind:
      outcome.kind === "answered" && outcome.result.stopReason !== "error"
        ? "answered"
        : "failed",
    body:
      outcome.kind === "answered"
        ? outcome.result.stopReason === "error"
          ? (outcome.result.errorMessage ?? (outcome.result.text || "error"))
          : outcome.result.text
        : outcome.reason,
    ...(info?.profile ? { profile: info.profile } : {}),
    ...(info ? { model: shortModel(info) } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** What the parent model reads. */
export function resultContent(details: ResultDetails): string {
  return details.kind === "answered"
    ? `Agent ${details.name} answered:\n\n${details.body || "(empty)"}`
    : `Agent ${details.name} failed: ${details.body}`;
}

export function resultHeader(
  details: ResultDetails,
  color: Colorize = plainColorize,
): string {
  const style =
    details.kind === "answered" ? STATE_STYLES.idle : STATE_STYLES.failed;
  const meta = [details.profile, details.model, details.usage]
    .filter(Boolean)
    .join(" · ");
  return `${color(style.color, style.icon)} ${details.name} ${details.kind === "answered" ? "answered" : "failed"}${meta ? color("dim", ` · ${meta}`) : ""}`;
}

function collapse(body: string, expanded: boolean): string {
  if (expanded) return body;
  const lines = body.split("\n");
  if (lines.length <= COLLAPSED_LINES) return body;
  return `${lines.slice(0, COLLAPSED_LINES).join("\n")}\n\n… ${lines.length - COLLAPSED_LINES} more lines`;
}

const renderResult: MessageRenderer = (message, options, theme) => {
  const details = message.details;
  const color: Colorize = (name, text) => theme.fg(name, text);
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  if (!isResultDetails(details)) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
    card.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
    return card;
  }
  card.addChild(new Text(resultHeader(details, color), 0, 0));
  if (details.body) {
    card.addChild(new Spacer(1));
    card.addChild(
      details.kind === "answered"
        ? new Markdown(
            collapse(details.body, options.expanded),
            0,
            0,
            getMarkdownTheme(),
          )
        : new Text(color("error", details.body), 0, 0),
    );
  }
  return card;
};

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RESULT_MESSAGE, renderResult);
}
