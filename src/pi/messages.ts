/**
 * Agent and group results posted into the parent conversation: the
 * model-facing text and the TUI cards.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  AgentDelivery,
  AgentInfo,
  AgentState,
  GroupMember,
  GroupPolicy,
} from "../agents/types.js";
import {
  type Colorize,
  formatUsage,
  plainColorize,
  STATE_STYLES,
  shortModel,
} from "../ui/format.js";

export const RESULT_MESSAGE = "pi-agents:result";
export const GROUP_RESULT_MESSAGE = "pi-agents:group-result";

/** Lines of a collapsed result body. */
const COLLAPSED_LINES = 12;
/** Lines of each agent's collapsed result in a group card. */
const COLLAPSED_MEMBER_LINES = 6;
/** Characters of one agent's result passed to the parent model. */
const MAX_RESULT_CHARS = 40_000;

export function truncateResult(body: string): string {
  if (body.length <= MAX_RESULT_CHARS) return body;
  return `${body.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated: ${body.length - MAX_RESULT_CHARS} more characters. Attach to the agent to read all of it.]`;
}

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

function isResultDetails(value: unknown): value is ResultDetails {
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
  delivery: AgentDelivery,
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

function resultHeader(
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

/** How one agent of a group did; `working` only in timed-out waits. */
export type MemberKind =
  | "answered"
  | "failed"
  | "interrupted"
  | "stopped"
  | "working";

export interface MemberDetails {
  agentId: string;
  name: string;
  kind: MemberKind;
  /** The result text, or the failure reason. */
  body: string;
  profile?: string;
  model?: string;
  usage?: string;
}

export interface GroupResultDetails {
  version: 1;
  groupId: string;
  name: string;
  policy: GroupPolicy;
  members: MemberDetails[];
}

function isGroupResultDetails(value: unknown): value is GroupResultDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return (
    details.version === 1 &&
    typeof details.groupId === "string" &&
    typeof details.name === "string" &&
    Array.isArray(details.members)
  );
}

export function memberDetails(
  member: GroupMember,
  info: AgentInfo | undefined,
): MemberDetails {
  const outcome = member.outcome;
  const usage = info ? formatUsage(info.usage) : "";
  let kind: MemberKind = "working";
  let body = "";
  if (outcome?.kind === "answered") {
    const failed = outcome.result.stopReason === "error";
    kind = failed ? "failed" : "answered";
    body = failed
      ? (outcome.result.errorMessage ?? (outcome.result.text || "error"))
      : outcome.result.text;
  } else if (outcome?.kind === "failed") {
    kind = "failed";
    body = outcome.reason;
  } else if (outcome) {
    kind = outcome.kind;
  }
  return {
    agentId: member.agentId,
    name: member.name,
    kind,
    body,
    ...(info?.profile ? { profile: info.profile } : {}),
    ...(info ? { model: shortModel(info) } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function groupResultDetails(
  group: { id: string; name: string; policy: GroupPolicy },
  members: readonly GroupMember[],
  lookup: (agentId: string) => AgentInfo | undefined,
): GroupResultDetails {
  return {
    version: 1,
    groupId: group.id,
    name: group.name,
    policy: group.policy,
    members: members.map((member) =>
      memberDetails(member, lookup(member.agentId)),
    ),
  };
}

/** `2 answered, 1 failed`. */
export function memberCounts(members: readonly MemberDetails[]): string {
  const order: MemberKind[] = [
    "answered",
    "failed",
    "interrupted",
    "stopped",
    "working",
  ];
  return order
    .flatMap((kind) => {
      const count = members.filter((member) => member.kind === kind).length;
      return count > 0 ? [`${count} ${kind}`] : [];
    })
    .join(", ");
}

/** Each agent's result under a heading of the given level. */
export function membersContent(
  details: GroupResultDetails,
  level: number,
): string {
  const hashes = "#".repeat(level);
  return details.members
    .map((member) => {
      const head = `${hashes} ${member.name} (${member.kind})`;
      if (member.kind === "answered")
        return `${head}\n${truncateResult(member.body || "(empty)")}`;
      if (member.kind === "failed") return `${head}\nError: ${member.body}`;
      return head;
    })
    .join("\n\n");
}

/** What the parent model reads for a finished group. */
export function groupContent(details: GroupResultDetails): string {
  return `Group ${details.name} finished: ${memberCounts(details.members)}.\n\n${membersContent(details, 2)}`;
}

const MEMBER_STATES: Record<MemberKind, AgentState> = {
  answered: "idle",
  failed: "failed",
  interrupted: "interrupted",
  stopped: "interrupted",
  working: "working",
};

function groupState(details: GroupResultDetails): AgentState {
  const kinds = details.members.map((member) => member.kind);
  if (kinds.includes("failed")) return "failed";
  if (kinds.some((kind) => kind !== "answered")) return "interrupted";
  return "idle";
}

const renderGroupResult: MessageRenderer = (message, options, theme) => {
  const details = message.details;
  if (!isGroupResultDetails(details))
    return renderResult(message, options, theme);
  const color: Colorize = (name, text) => theme.fg(name, text);
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const style = STATE_STYLES[groupState(details)];
  card.addChild(
    new Text(
      `${color(style.color, style.icon)} ${details.name} finished${color("dim", ` · ${memberCounts(details.members).replaceAll(", ", " · ")}`)}`,
      0,
      0,
    ),
  );
  for (const member of details.members) {
    const memberStyle = STATE_STYLES[MEMBER_STATES[member.kind]];
    const meta = [member.profile, member.model, member.usage]
      .filter(Boolean)
      .join(" · ");
    card.addChild(new Spacer(1));
    card.addChild(
      new Text(
        `${color(memberStyle.color, memberStyle.icon)} ${member.name}${meta ? color("dim", ` · ${meta}`) : ""}`,
        0,
        0,
      ),
    );
    if (!member.body) continue;
    const lines = member.body.split("\n");
    const body =
      options.expanded || lines.length <= COLLAPSED_MEMBER_LINES
        ? member.body
        : `${lines.slice(0, COLLAPSED_MEMBER_LINES).join("\n")}\n\n… ${lines.length - COLLAPSED_MEMBER_LINES} more lines`;
    card.addChild(
      member.kind === "failed"
        ? new Text(color("error", body), 0, 0)
        : new Markdown(body, 0, 0, getMarkdownTheme()),
    );
  }
  return card;
};

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
  pi.registerMessageRenderer(GROUP_RESULT_MESSAGE, renderGroupResult);
}
