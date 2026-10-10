/**
 * What agents and graphs produced: an agent's latest turn, and the text of a
 * graph's result for the parent model and for an agent that waits for its
 * helpers. Pure functions over plain data.
 */

import type { AgentInfo, AgentState, GraphNode } from "./types.js";

/**
 * What an agent's latest turn produced: its answer, what it wrote before it
 * was interrupted, or why it failed. Nothing while it works or waits, and
 * nothing of an earlier turn.
 */
export function turnResult(info: AgentInfo): {
  result?: string;
  error?: string;
} {
  const ended = info.unanswered;
  const own = ended && !ended.current ? undefined : info.result;
  switch (info.state) {
    case "idle":
      return own ? { result: own.text } : {};
    case "interrupted":
      return own?.text ? { result: own.text } : {};
    case "failed":
      return {
        error:
          own?.errorMessage ??
          ended?.detail ??
          (own?.text || ended?.reason || "unknown"),
      };
    default:
      return {};
  }
}

/** How one agent of a graph did; `working` and `waiting` only in waits
 * that timed out. In report order. */
export const NODE_KINDS = [
  "answered",
  "failed",
  "interrupted",
  "stopped",
  "skipped",
  "working",
  "waiting",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export interface ReportNode {
  name: string;
  kind: NodeKind;
  /** The result text, or the failure reason. */
  body: string;
  /** Whether no other agent of the graph needs its result. */
  end: boolean;
}

/**
 * How one agent of a graph did its task, and its answer or error: from the
 * node's outcome once it has one, else from the agent's state.
 */
export function nodeResult(
  node: GraphNode,
  state: AgentState | undefined,
): { kind: NodeKind; body: string } {
  const outcome = node.outcome;
  if (!outcome)
    return { kind: state === "waiting" ? "waiting" : "working", body: "" };
  if (outcome.kind === "answered") {
    const { result } = outcome;
    return result.stopReason === "error"
      ? {
          kind: "failed",
          body: result.errorMessage ?? (result.text || "error"),
        }
      : { kind: "answered", body: result.text };
  }
  if (outcome.kind === "failed")
    return { kind: "failed", body: outcome.reason };
  return { kind: outcome.kind, body: "" };
}

/** How much of one result the text keeps. */
export interface ResultLimit {
  chars: number;
  lines: number;
  /** Appended to the truncation notice. */
  hint: string;
}

export const PARENT_LIMIT: ResultLimit = {
  chars: 40_000,
  lines: Number.POSITIVE_INFINITY,
  hint: "Attach to the agent to read all of it.",
};

/** Cut a result to its limit: the text it keeps and how many characters it
 * leaves out. */
export function cutResult(
  body: string,
  limit: ResultLimit = PARENT_LIMIT,
): { text: string; omitted: number } {
  const lines = body.split("\n");
  const kept = lines.length > limit.lines ? lines.slice(0, limit.lines) : lines;
  const text = kept.join("\n").slice(0, limit.chars);
  return { text, omitted: body.length - text.length };
}

/** Cut a result to its limit, saying how much is left out. */
export function truncateResult(
  body: string,
  limit: ResultLimit = PARENT_LIMIT,
): string {
  const { text, omitted } = cutResult(body, limit);
  if (omitted <= 0) return body;
  return `${text}\n\n[Result truncated: ${omitted} more characters. ${limit.hint}]`;
}

/** `2 answered, 1 failed`. */
export function nodeCounts(nodes: readonly ReportNode[]): string {
  return NODE_KINDS.flatMap((kind) => {
    const count = nodes.filter((node) => node.kind === kind).length;
    return count > 0 ? [`${count} ${kind}`] : [];
  }).join(", ");
}

/** What a node without an answer says about itself. */
export function nodeNote(node: ReportNode): string {
  if (node.kind === "failed") return `failed: ${node.body}`;
  if (node.kind === "skipped")
    return "was skipped because none of its inputs answered";
  return `was ${node.kind}`;
}

/** Each agent's result under a heading of the given level. */
export function nodesContent(
  nodes: readonly ReportNode[],
  level: number,
  limit: ResultLimit = PARENT_LIMIT,
): string {
  const hashes = "#".repeat(level);
  return nodes
    .map((node) => {
      const head = `${hashes} ${node.name} (${node.kind})`;
      if (node.kind === "answered")
        return `${head}\n${truncateResult(node.body || "(empty)", limit)}`;
      if (node.kind === "failed") return `${head}\nError: ${node.body}`;
      return head;
    })
    .join("\n\n");
}

/**
 * A finished graph's result: the results of the agents nothing waits for. A
 * single one reads as that agent's answer. Agents in between that didn't
 * answer are named after it.
 */
export function graphReport(
  name: string,
  nodes: readonly ReportNode[],
  limit: ResultLimit = PARENT_LIMIT,
): string {
  const ends = nodes.filter((node) => node.end);
  const [only] = ends;
  const main =
    ends.length === 1 && only
      ? only.kind === "answered"
        ? `Graph ${name}: ${only.name} answered:\n\n${truncateResult(only.body || "(empty)", limit)}`
        : `Graph ${name}: ${only.name} ${nodeNote(only)}.`
      : `Graph ${name} finished: ${nodeCounts(ends)}.\n\n${nodesContent(ends, 2, limit)}`;
  const others = nodes.filter((node) => !node.end && node.kind !== "answered");
  if (others.length === 0) return main;
  return `${main}\n\nOther agents: ${others.map((node) => `${node.name} ${nodeNote(node)}`).join("; ")}.`;
}
