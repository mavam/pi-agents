/**
 * Pure derivations from pi-durable's committed state to the agent view:
 * state, usage, live activity, and results.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  EntryRecord,
  LiveState,
  SubmissionRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import {
  type AgentActivity,
  type AgentResult,
  type AgentState,
  type AgentUsage,
  EMPTY_USAGE,
  type GroupMember,
  type RequestOutcome,
} from "./types.js";

export const ASSISTANT_KIND = "pi.assistant";

/** How the latest turn settled, as seen in this process. */
export type TurnSettlement = "answered" | "interrupted" | "failed";

export function settlementOf(
  submission: SubmissionRecord,
): TurnSettlement | undefined {
  if (submission.type !== "input") return undefined;
  if (submission.status === "done") return "answered";
  if (submission.status === "unanswered")
    return submission.reason === "aborted" ? "interrupted" : "failed";
  return undefined;
}

export function deriveState(
  live: LiveState | undefined,
  last: AgentResult | undefined,
  settlement?: TurnSettlement,
): AgentState {
  if (live?.run !== undefined) return "working";
  // A turn can end without an answer entry, for example when it was
  // interrupted before the first token.
  if (settlement === "interrupted") return "interrupted";
  if (settlement === "failed") return "failed";
  if (last?.stopReason === "aborted") return "interrupted";
  if (last?.stopReason === "error") return "failed";
  return "idle";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function summarizeUsage(state: UsageState | undefined): AgentUsage {
  if (!state) return { ...EMPTY_USAGE };
  const total = { ...EMPTY_USAGE };
  for (const bucket of [state.models, state.tools]) {
    for (const usage of Object.values(bucket ?? {})) {
      const record = usage as Record<string, unknown>;
      total.input += numberOf(record.input);
      total.output += numberOf(record.output);
      total.cacheRead += numberOf(record.cacheRead);
      total.cacheWrite += numberOf(record.cacheWrite);
      const cost = record.cost as Record<string, unknown> | undefined;
      total.cost += numberOf(cost?.total);
    }
  }
  return total;
}

/** Add the usage of a streaming answer that is not committed as an entry yet. */
export function addPartialUsage(
  usage: AgentUsage,
  live: LiveState | undefined,
): AgentUsage {
  const message = live?.generation?.message as AssistantMessage | undefined;
  const partial = message?.usage;
  if (!partial) return usage;
  return {
    input: usage.input + numberOf(partial.input),
    output: usage.output + numberOf(partial.output),
    cacheRead: usage.cacheRead + numberOf(partial.cacheRead),
    cacheWrite: usage.cacheWrite + numberOf(partial.cacheWrite),
    cost: usage.cost + numberOf(partial.cost?.total),
  };
}

/** The latest bold Markdown headline of reasoning text, as providers emit
 * reasoning summaries (`**Planning the fix**`). */
export function latestHeadline(thinking: string): string | undefined {
  const matches = [...thinking.matchAll(/\*\*([^*\n]{2,120})\*\*/g)];
  const last = matches.at(-1)?.[1]?.trim();
  return last && last.length > 0 ? last : undefined;
}

export function activityOf(live: LiveState | undefined): AgentActivity {
  if (!live) return {};
  const activity: AgentActivity = {};
  const running = live.tools?.find((slot) => slot.status === "running");
  if (running) activity.tool = running.name;
  const message = live.generation?.message as AssistantMessage | undefined;
  if (message) {
    const thinking = message.content
      .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
      .join("\n");
    const headline = latestHeadline(thinking);
    if (headline) activity.summary = headline;
  }
  if (live.generation?.retry) activity.retry = live.generation.retry.error;
  if ((live.compactions?.length ?? 0) > 0) activity.compacting = true;
  return activity;
}

function messageText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

/** The result an assistant entry carries, or undefined for other entries. */
export function resultOf(
  entry: EntryRecord | undefined,
  agentId: string,
  name: string,
): AgentResult | undefined {
  if (!entry || entry.kind !== ASSISTANT_KIND) return undefined;
  const message = entry.model?.[0] as AssistantMessage | undefined;
  if (message?.role !== "assistant") return undefined;
  return {
    agentId,
    name,
    entryId: entry.id,
    text: messageText(message),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}),
  };
}

/** What a submission settled with; undefined while it is still open. */
export function outcomeOf(
  submission: SubmissionRecord | undefined,
  answer: EntryRecord | undefined,
  agentId: string,
  name: string,
): RequestOutcome | undefined {
  if (submission?.type !== "input") return undefined;
  if (submission.status === "done") {
    const result = resultOf(answer, agentId, name);
    if (!result) return { kind: "failed", reason: "answer missing" };
    if (result.stopReason === "aborted") return { kind: "aborted" };
    return { kind: "answered", result };
  }
  if (submission.status === "unanswered") {
    return submission.reason === "aborted"
      ? { kind: "aborted" }
      : { kind: "failed", reason: submission.reason };
  }
  return undefined;
}

/**
 * A group's state: `working` until the group task ended, then `interrupted`
 * when it was stopped, `failed` when an agent failed, `interrupted` when an
 * agent was interrupted or stopped, and `idle` when every agent answered.
 */
export function deriveGroupState(
  ended: { status: string } | undefined,
  members: readonly GroupMember[],
): AgentState {
  if (!ended) return "working";
  if (ended.status === "aborted") return "interrupted";
  if (ended.status !== "completed") return "failed";
  const kinds = members.map((member) => member.outcome?.kind);
  if (kinds.some((kind) => kind === undefined || kind === "failed"))
    return "failed";
  if (kinds.some((kind) => kind !== "answered")) return "interrupted";
  return "idle";
}

export function sumUsage(usages: readonly AgentUsage[]): AgentUsage {
  const total = { ...EMPTY_USAGE };
  for (const usage of usages) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.cost += usage.cost;
  }
  return total;
}
