/**
 * The text of a graph's result, for the parent model and for an agent that
 * waits for its helpers. Pure functions over plain data.
 */

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
