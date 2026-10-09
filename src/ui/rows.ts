/**
 * Rows of the panel and of `/agents`: graphs and standalone agents, each
 * graph followed by its agents in stages, and an agent followed by the
 * helpers it started, drawn as a tree. Graphs and agents with helpers fold;
 * a `Disclosure` remembers what the user folded, shared by both views.
 */

import type { AgentInfo, GraphInfo } from "../agents/types.js";

interface Tree {
  /** Tree connectors before the line. */
  lead: string;
  /** Agents below the row, at any depth; 0 for a leaf. */
  below: number;
  /** Whether the agents below show. */
  expanded: boolean;
  /** The row this one sits below, by key. */
  parent?: string;
}

export type Row =
  | ({ kind: "graph"; key: string; graph: GraphInfo } & Tree)
  | ({
      kind: "agent";
      key: string;
      agent: AgentInfo;
      /** Whether the agent belongs to the graph above it. */
      nested: boolean;
      /** Whether it is its graph's last agent. */
      last: boolean;
      /** Names of the agents whose results it receives. */
      inputs: string[];
    } & Tree);

/** What the user folded and unfolded, by row key, over a default. */
export class Disclosure {
  private readonly state = new Map<string, boolean>();

  isExpanded(key: string, fallback: boolean): boolean {
    return this.state.get(key) ?? fallback;
  }

  set(key: string, expanded: boolean): void {
    this.state.set(key, expanded);
  }
}

/**
 * Fold or unfold a row: a row with agents below it toggles, and a row
 * without folds the row it sits below. Returns the key to select next.
 */
export function fold(row: Row, disclosure: Disclosure): string {
  if (row.below > 0) {
    disclosure.set(row.key, !row.expanded);
    return row.key;
  }
  if (row.parent === undefined) return row.key;
  disclosure.set(row.parent, false);
  return row.parent;
}

/** `9 hidden` for a folded row, else nothing. */
export function hiddenNote(row: Row): string | undefined {
  return row.below > 0 && !row.expanded ? `${row.below} hidden` : undefined;
}

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
 * agents in stages, and an agent by the graphs of helpers it started,
 * unless folded. `expand` says whether a graph shows its agents unless the
 * user chose otherwise. An agent whose graph is not among `graphs` stands
 * alone, and so does a graph whose agent isn't shown.
 */
export function buildRows(
  source: RowSource,
  order: EntryOrder,
  expand: (graph: GraphInfo) => boolean,
  disclosure: Disclosure = new Disclosure(),
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

  /** Agents below a graph, helpers included. */
  const graphBelow = (graph: GraphInfo): number =>
    graph.nodes.reduce((sum, node) => sum + 1 + agentBelow(node.agentId), 0);
  const agentBelow = (agentId: string): number =>
    (owned.get(agentId) ?? []).reduce(
      (sum, graph) => sum + graphBelow(graph),
      0,
    );

  /** A graph row, then its agents, each followed by its helpers. */
  const graphRows = (
    graph: GraphInfo,
    lead: string,
    indent: string,
    parent?: string,
  ): Row[] => {
    const key = `graph:${graph.id}`;
    const expanded = disclosure.isExpanded(key, expand(graph));
    const head: Row = {
      kind: "graph",
      key,
      graph,
      lead,
      below: graphBelow(graph),
      expanded,
      ...(parent ? { parent } : {}),
    };
    if (!expanded) return [head];
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
          key,
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
    parent?: string,
  ): Row[] => {
    const key = `agent:${agent.id}`;
    const helpers = owned.get(agent.id) ?? [];
    const expanded = disclosure.isExpanded(key, true);
    const row: Row = {
      kind: "agent",
      key,
      agent,
      lead,
      below: agentBelow(agent.id),
      expanded,
      ...(parent ? { parent } : {}),
      ...place,
    };
    if (!expanded) return [row];
    return [
      row,
      ...helpers.flatMap((graph, index) => {
        const last = index === helpers.length - 1;
        return graphRows(
          graph,
          `${indent}${last ? "└─ " : "├─ "}`,
          `${indent}${last ? "   " : "│  "}`,
          key,
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
