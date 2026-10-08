/**
 * Rows of the panel and of `/agents`: graphs and standalone agents, each
 * graph followed by its agents in stages, and an agent followed by the
 * helpers it started, drawn as a tree.
 */

import type { AgentInfo, GraphInfo } from "../agents/types.js";

export type Row =
  | {
      kind: "graph";
      key: string;
      graph: GraphInfo;
      /** Tree connectors before the line. */
      lead: string;
    }
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
      lead: string;
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
 * agents in stages when `expand` says so, and an agent by the graphs of
 * helpers it started. An agent whose graph is not among `graphs` stands
 * alone, and so does a graph whose agent isn't shown.
 */
export function buildRows(
  source: RowSource,
  order: EntryOrder,
  expand: (graph: GraphInfo) => boolean,
): Row[] {
  const graphIds = new Set(source.graphs.map((graph) => graph.id));
  const owned = new Map<string, GraphInfo[]>();
  for (const graph of source.graphs)
    if (graph.owner)
      owned.set(graph.owner, [...(owned.get(graph.owner) ?? []), graph]);
  const standalone = source.agents.filter(
    (info) => info.graph === undefined || !graphIds.has(info.graph),
  );
  const shown = new Set<string>([
    ...standalone.map((info) => info.id),
    ...source.graphs
      .filter((graph) => !graph.owner)
      .flatMap((graph) => graph.nodes.map((node) => node.agentId)),
  ]);
  const entries: Entry[] = [
    ...source.graphs
      .filter((graph) => !graph.owner || !shown.has(graph.owner))
      .map((info) => ({ kind: "graph" as const, info })),
    ...standalone.map((info) => ({ kind: "agent" as const, info })),
  ].sort((left, right) => order(left.info, right.info));

  /** A graph row, then its agents, each followed by its helpers. */
  const graphRows = (graph: GraphInfo, lead: string, indent: string): Row[] => {
    const head: Row = { kind: "graph", key: `graph:${graph.id}`, graph, lead };
    if (!expand(graph)) return [head];
    const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
    const nodes = graph.nodes.flatMap((node) => {
      const agent = source.agent(node.agentId);
      return agent ? [{ node, agent }] : [];
    });
    return [
      head,
      ...nodes.flatMap(({ node, agent }, index) => {
        const last = index === nodes.length - 1;
        return agentRows(
          agent,
          {
            nested: true,
            last,
            inputs: node.inputs.map((input) => names.get(input) ?? input),
          },
          `${indent}${last ? "└─ " : "├─ "}`,
          `${indent}${last ? "   " : "│  "}`,
        );
      }),
    ];
  };

  /** An agent row, then the graphs of helpers it started. */
  const agentRows = (
    agent: AgentInfo,
    place: { nested: boolean; last: boolean; inputs: string[] },
    lead: string,
    indent: string,
  ): Row[] => {
    const helpers = owned.get(agent.id) ?? [];
    return [
      { kind: "agent", key: `agent:${agent.id}`, agent, lead, ...place },
      ...helpers.flatMap((graph, index) => {
        const last = index === helpers.length - 1;
        return graphRows(
          graph,
          `${indent}${last ? "└─ " : "├─ "}`,
          `${indent}${last ? "   " : "│  "}`,
        );
      }),
    ];
  };

  return entries.flatMap((entry) =>
    entry.kind === "graph"
      ? graphRows(entry.info, "", "")
      : agentRows(
          entry.info,
          { nested: false, last: false, inputs: [] },
          "",
          "",
        ),
  );
}

/** The tree connectors before a row's line. */
export function connector(row: Row): string {
  return row.lead;
}

/** The agent a row attaches to: the agent, or a graph's first agent. */
export function attachTarget(row: Row): string | undefined {
  return row.kind === "agent" ? row.agent.id : row.graph.nodes[0]?.agentId;
}
