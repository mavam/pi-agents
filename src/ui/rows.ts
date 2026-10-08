/**
 * Rows of the panel and of `/agents`: graphs and standalone agents, each
 * graph followed by its agents in stages, drawn as a tree.
 */

import type { AgentInfo, GraphInfo } from "../agents/types.js";

export type Row =
  | { kind: "graph"; key: string; graph: GraphInfo }
  | {
      kind: "agent";
      key: string;
      agent: AgentInfo;
      /** Whether the agent belongs to the graph above it. */
      nested: boolean;
      /** Whether it is its graph's last agent. */
      last: boolean;
      /** Names of the agents whose results it receives. */
      inputs: string[];
    };

export interface RowSource {
  /** Candidate standalone agents. */
  agents: readonly AgentInfo[];
  graphs: readonly GraphInfo[];
  /** A graph's agent by ID. */
  agent: (id: string) => AgentInfo | undefined;
}

type Entry =
  | { kind: "graph"; info: GraphInfo }
  | { kind: "agent"; info: AgentInfo };

export type EntryOrder = (
  left: Pick<AgentInfo, "state" | "createdAt" | "closed">,
  right: Pick<AgentInfo, "state" | "createdAt" | "closed">,
) => number;

/**
 * Graphs and the agents outside them in `order`; a graph is followed by its
 * agents in stages when `expand` says so. An agent whose graph is not among
 * `graphs` stands alone.
 */
export function buildRows(
  source: RowSource,
  order: EntryOrder,
  expand: (graph: GraphInfo) => boolean,
): Row[] {
  const graphIds = new Set(source.graphs.map((graph) => graph.id));
  const entries: Entry[] = [
    ...source.graphs.map((info) => ({ kind: "graph" as const, info })),
    ...source.agents
      .filter((info) => info.graph === undefined || !graphIds.has(info.graph))
      .map((info) => ({ kind: "agent" as const, info })),
  ].sort((left, right) => order(left.info, right.info));
  return entries.flatMap((entry): Row[] => {
    if (entry.kind === "agent")
      return [
        {
          kind: "agent",
          key: `agent:${entry.info.id}`,
          agent: entry.info,
          nested: false,
          last: false,
          inputs: [],
        },
      ];
    const graph = entry.info;
    const head: Row = { kind: "graph", key: `graph:${graph.id}`, graph };
    if (!expand(graph)) return [head];
    const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
    const nodes = graph.nodes.flatMap((node) => {
      const agent = source.agent(node.agentId);
      return agent ? [{ node, agent }] : [];
    });
    return [
      head,
      ...nodes.map(
        ({ node, agent }, index): Row => ({
          kind: "agent",
          key: `agent:${agent.id}`,
          agent,
          nested: true,
          last: index === nodes.length - 1,
          inputs: node.inputs.map((input) => names.get(input) ?? input),
        }),
      ),
    ];
  });
}

/** The tree connector before a row's line. */
export function connector(row: Row): string {
  if (row.kind === "graph" || !row.nested) return "";
  return row.last ? "└─ " : "├─ ";
}

/** The agent a row attaches to: the agent, or a graph's first agent. */
export function attachTarget(row: Row): string | undefined {
  return row.kind === "agent" ? row.agent.id : row.graph.nodes[0]?.agentId;
}
