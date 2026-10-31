/**
 * Pure derivations from pi-durable's committed state to the agent view:
 * state, usage, live activity, and results.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  EntryRecord,
  LiveState,
  RunFailure,
  SubmissionRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import {
  type AgentActivity,
  type AgentResult,
  type AgentState,
  type AgentUsage,
  EMPTY_USAGE,
  type GraphNode,
  type RequestOutcome,
} from "./types.js";

export const ASSISTANT_KIND = "pi.assistant";
/** The task kind that runs an agent's turns; the latest one ends a run. */
export const GENERATION_KIND = "pi.generation";

/**
 * Why runs end without an answer but not by the agent's fault: an
 * interrupt (`aborted`), or crashes that cut its work off (`interrupted`,
 * `restart_limit`). Such a run leaves the requests it answers open for a
 * later answer, such as one after the user continued the agent.
 */
const CORRECTIONS: ReadonlySet<string> = new Set([
  "aborted",
  "interrupted",
  "restart_limit",
]);

/** Whether a run that ended for `reason` keeps its requests open. */
export function keepsRequestsOpen(reason: string): boolean {
  return CORRECTIONS.has(reason);
}

/**
 * Why the agent's latest run ended without an answer, from `pi.live`, which
 * keeps it until the next run starts. A continue that found nothing to
 * answer didn't fail: the agent's answer still stands.
 */
export function runFailureOf(
  live: LiveState | undefined,
): RunFailure | undefined {
  const failure = live?.runFailure;
  return failure?.reason === "nothing_to_answer" ? undefined : failure;
}

export function deriveState(
  live: LiveState | undefined,
  last: AgentResult | undefined,
): AgentState {
  if (live?.run !== undefined) return "working";
  // A run can end without an answer entry, for example when it was
  // interrupted before the first token.
  const failure = runFailureOf(live);
  if (failure) return failure.reason === "aborted" ? "interrupted" : "failed";
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

/**
 * What a submission settled with, or `interrupted` when its turn was
 * aborted: the request then stays open for a later answer, after `since`,
 * its input entry, or its admission when it was never placed. Undefined
 * while the submission is still open.
 */
export type SubmissionOutcome =
  | RequestOutcome
  | { kind: "interrupted"; since: number };

export function outcomeOf(
  submission: SubmissionRecord | undefined,
  answer: EntryRecord | undefined,
  agentId: string,
  name: string,
): SubmissionOutcome | undefined {
  if (submission?.type !== "input") return undefined;
  const interrupted: SubmissionOutcome = {
    kind: "interrupted",
    since: Number(submission.entry ?? submission.id),
  };
  if (submission.status === "done") {
    const result = resultOf(answer, agentId, name);
    if (!result) return { kind: "failed", reason: "answer missing" };
    if (result.stopReason === "aborted") return interrupted;
    return { kind: "answered", result };
  }
  if (submission.status === "unanswered") {
    return keepsRequestsOpen(submission.reason)
      ? interrupted
      : {
          kind: "failed",
          reason: submission.reason,
          ...(typeof submission.detail === "string"
            ? { detail: submission.detail }
            : {}),
        };
  }
  return undefined;
}

/**
 * A graph's state: `working` until the graph task ended, then `interrupted`
 * when it was stopped, and otherwise derived from the agents nothing waits
 * for: `failed` when one failed or was skipped, `interrupted` when one was
 * interrupted or stopped, and `idle` when they all answered.
 */
export function deriveGraphState(
  ended: { status: string } | undefined,
  nodes: readonly GraphNode[],
): AgentState {
  if (!ended) return "working";
  if (ended.status === "aborted") return "interrupted";
  if (ended.status !== "completed") return "failed";
  const kinds = nodes
    .filter((node) => node.end)
    .map((node) => node.outcome?.kind);
  if (
    kinds.some(
      (kind) => kind === undefined || kind === "failed" || kind === "skipped",
    )
  )
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
