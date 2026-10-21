/**
 * Obligations: the groups an agent spawned whose results it still has to
 * take into account. An answer settles the agent's work, such as its job
 * in a group or a parent's request, only once it follows every result the
 * agent was owed when it answered. An answer that comes before, such as
 * "checking with my agents", is an intermediate one: the work stays open
 * until a later answer follows the results.
 *
 * The evidence lives in the agent's transcript, so the service and the
 * group tasks decide alike and after restarts: an input entry that carried
 * a group's result, or the result of an `agent_wait` call that returned it.
 */

import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type GraphRecord, isSpawned } from "./records.js";

/** The kind of an input entry that hands an agent its groups' results. */
export const RESULTS_ENTRY = "pi-agents.results";

export type ResultsEntryData = { groups: string[] };

/** Marks a group's result among an agent's inputs. */
export const RESULTS_PREFIX = "[results] ";

const ASSISTANT = "pi.assistant";
const USER = "pi.user";
const TOOL_RESULT = "pi.tool-result";

/** One group an agent awaits: since when, and where it got the result if
 * the group record knows. */
export interface Obligation {
  group: string;
  /** The agent's entry that spawned it. */
  since: number;
  presented?: number;
}

/** The spawned groups of an agent whose results count; cancelled ones
 * don't. */
export function obligationsOf(
  agentId: string,
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
): Obligation[] {
  return Object.entries(graphs ?? {}).flatMap(([group, graph]) =>
    isSpawned(graph) &&
    graph.owner.agent === agentId &&
    graph.cancelled !== true &&
    graph.owner.since !== undefined
      ? [
          {
            group,
            since: graph.owner.since,
            ...(graph.presented !== undefined
              ? { presented: graph.presented }
              : {}),
          },
        ]
      : [],
  );
}

/** Where a scan for evidence must start: early enough to see where each
 * unmarked group was presented. */
export function scanStart(
  since: number,
  obligations: readonly Obligation[],
): number {
  return Math.min(
    since,
    ...obligations
      .filter((each) => each.presented === undefined)
      .map((each) => each.since),
  );
}

/** Groups whose results the entry handed to its agent. */
export function presentedGroups(entry: EntryRecord): string[] {
  if (entry.kind === RESULTS_ENTRY) {
    const groups = (entry.data as Partial<ResultsEntryData> | undefined)
      ?.groups;
    return Array.isArray(groups) ? groups.map(String) : [];
  }
  if (entry.kind === TOOL_RESULT) {
    const message = entry.model?.[0] as ToolResultMessage | undefined;
    const details = message?.details as { presented?: unknown } | undefined;
    if (message?.isError) return [];
    return Array.isArray(details?.presented)
      ? details.presented.map(String)
      : [];
  }
  return [];
}

/** Whether the entry is input to the agent: the user's, the parent's, an
 * agent's message, or a group's result, whatever its kind. */
export function isInput(entry: EntryRecord): boolean {
  if (entry.kind === USER) return true;
  if (entry.kind.startsWith("pi.")) return false;
  return (entry.model?.[0] as { role?: string } | undefined)?.role === "user";
}

/** A final answer: one that ended normally, not a tool call, error, or
 * interruption. */
export function isFinalAnswer(entry: EntryRecord): boolean {
  if (entry.kind !== ASSISTANT) return false;
  const message = entry.model?.[0] as AssistantMessage | undefined;
  return message?.stopReason === "stop" || message?.stopReason === "length";
}

/**
 * The answer that settles work whose input entered at `since`: the first
 * final answer after an input from `since` on that follows the results of
 * every group the agent spawned before it. `entries` ascend and start at
 * `scanStart(since, obligations)` or earlier.
 */
export function coveringAnswer(
  entries: Iterable<EntryRecord>,
  since: number,
  obligations: readonly Obligation[],
): EntryRecord | undefined {
  const presented = new Map<string, number>();
  for (const each of obligations)
    if (each.presented !== undefined) presented.set(each.group, each.presented);
  let input = false;
  for (const entry of entries) {
    for (const group of presentedGroups(entry))
      if (!presented.has(group)) presented.set(group, entry.id);
    if (isInput(entry)) {
      if (entry.id >= since) input = true;
      continue;
    }
    if (!input || !isFinalAnswer(entry)) continue;
    const covered = obligations.every(
      (each) =>
        each.since >= entry.id ||
        (presented.get(each.group) ?? Number.POSITIVE_INFINITY) < entry.id,
    );
    if (covered) return entry;
  }
  return undefined;
}

/** Whether the answer settles work: no result it was owed is missing. */
export function covers(
  answer: number,
  obligations: readonly Obligation[],
): boolean {
  return obligations.every(
    (each) =>
      each.since >= answer ||
      (each.presented !== undefined && each.presented < answer),
  );
}
