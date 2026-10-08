/**
 * The text of a graph's result, for the parent model and for an agent that
 * waits for its helpers. Pure functions over plain data.
 */

/** How one agent of a graph did; `working` and `waiting` only in waits
 * that timed out. */
export type NodeKind =
  | "answered"
  | "failed"
  | "interrupted"
  | "stopped"
  | "skipped"
  | "working"
  | "waiting";

export interface ReportNode {
  name: string;
  kind: NodeKind;
  /** The result text, or the failure reason. */
  body: string;
  /** Whether no other agent of the graph needs its result. */
  end: boolean;
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

/** Cut a result to its limit, saying how much is left out. */
export function truncateResult(
  body: string,
  limit: ResultLimit = PARENT_LIMIT,
): string {
  const lines = body.split("\n");
  let kept = lines.length > limit.lines ? lines.slice(0, limit.lines) : lines;
  let text = kept.join("\n");
  if (text.length > limit.chars) {
    text = text.slice(0, limit.chars);
    kept = text.split("\n");
  }
  const missing = body.length - text.length;
  if (missing <= 0) return body;
  return `${text}\n\n[Result truncated: ${missing} more characters. ${limit.hint}]`;
}

const KIND_ORDER: NodeKind[] = [
  "answered",
  "failed",
  "interrupted",
  "stopped",
  "skipped",
  "working",
  "waiting",
];

/** `2 answered, 1 failed`. */
export function nodeCounts(nodes: readonly ReportNode[]): string {
  return KIND_ORDER.flatMap((kind) => {
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
