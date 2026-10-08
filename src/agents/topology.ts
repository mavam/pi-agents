/**
 * Graph topology: edges, stages, cycles, end nodes, and the one-line shape.
 * Pure functions over node keys and their inputs, shared by validation,
 * tools, and rendering.
 */

import { AgentError } from "./types.js";

export interface TopologyNode {
  key: string;
  /** Keys of the nodes whose results this node needs. */
  inputs: readonly string[];
}

/** A cycle as keys, first key repeated at the end, if the graph has one. */
export function findCycle(
  nodes: readonly TopologyNode[],
): string[] | undefined {
  const inputs = new Map(nodes.map((node) => [node.key, node.inputs]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const seen = state.get(key);
    if (seen === "done") return undefined;
    if (seen === "visiting") return [...path.slice(path.indexOf(key)), key];
    state.set(key, "visiting");
    path.push(key);
    for (const input of inputs.get(key) ?? []) {
      const cycle = visit(input);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const node of nodes) {
    const cycle = visit(node.key);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Nodes in stages: a node's stage is one more than its latest input's, so
 * every node follows its inputs. Within a stage, nodes keep their order.
 * Assumes no cycles.
 */
export function stages(nodes: readonly TopologyNode[]): string[][] {
  const inputs = new Map(nodes.map((node) => [node.key, node.inputs]));
  const depth = new Map<string, number>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const own = (inputs.get(key) ?? [])
      .filter((input) => inputs.has(input))
      .reduce((max, input) => Math.max(max, depthOf(input) + 1), 0);
    depth.set(key, own);
    return own;
  };
  const byStage = new Map<number, string[]>();
  for (const node of nodes) {
    const stage = depthOf(node.key);
    byStage.set(stage, [...(byStage.get(stage) ?? []), node.key]);
  }
  return [...byStage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, keys]) => keys);
}

/** Keys of the nodes no other node needs, in node order. */
export function endNodes(nodes: readonly TopologyNode[]): string[] {
  const needed = new Set(nodes.flatMap((node) => node.inputs));
  return nodes.map((node) => node.key).filter((key) => !needed.has(key));
}

/** `map → {api, tests} → merge`, with `name` mapping keys to labels. */
export function shapeLine(
  nodes: readonly TopologyNode[],
  name: (key: string) => string = (key) => key,
): string {
  return stages(nodes)
    .map((stage) =>
      stage.length === 1
        ? name(stage[0] as string)
        : `{${stage.map(name).join(", ")}}`,
    )
    .join(" → ");
}

/**
 * Each node's inputs as node indexes, from the names in `after`, validated:
 * they name nodes of the same graph, not the node itself, and form no cycle.
 */
export function resolveEdges(
  nodes: ReadonlyArray<{ name: string; after?: readonly string[] }>,
): number[][] {
  const index = new Map(nodes.map((node, at) => [node.name, at]));
  const inputs = nodes.map((node, at) =>
    [...new Set((node.after ?? []).map((ref) => ref.trim()))]
      .filter(Boolean)
      .map((ref) => {
        const found = index.get(ref);
        if (found === undefined)
          throw new AgentError(
            `${node.name} waits for ${ref}, which is not an agent of this graph. Name the agents that others wait for.`,
          );
        if (found === at)
          throw new AgentError(`${node.name} cannot wait for itself`);
        return found;
      }),
  );
  const cycle = findCycle(
    nodes.map((node, at) => ({
      key: node.name,
      inputs: (inputs[at] ?? []).map((input) => nodes[input]?.name ?? ""),
    })),
  );
  if (cycle)
    throw new AgentError(
      `The agents wait for each other in a cycle: ${cycle.join(" → ")}`,
    );
  return inputs;
}
