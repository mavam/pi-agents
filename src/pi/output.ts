/**
 * What scripts get from the agent tools: names, states, and results as
 * plain data. Codemode hands a script a tool's structured content and turns
 * its output schema into a declaration. The model still reads the text.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TProperties, Type } from "typebox";
import { NODE_KINDS, turnResult } from "../agents/report.js";
import {
  AGENT_STATES,
  type AgentInfo,
  type GraphInfo,
  type Target,
} from "../agents/types.js";
import { nodeDetails } from "./messages.js";

/** An object with exactly these fields. */
function exact<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

/** What an agent's turn produced. */
const resultFields = {
  result: Type.Optional(
    Type.String({
      description:
        "Its answer, or what it wrote before it was interrupted; absent while it works",
    }),
  ),
  error: Type.Optional(Type.String({ description: "Why it failed" })),
};

const stalledField = {
  stalled: Type.Optional(
    StringEnum(["crashed", "incompatible"] as const, {
      description:
        "Its work doesn't run: crashes cut it off repeatedly and the user can retry it, or this pi-agents version can't run it",
    }),
  ),
};

export const AgentOutput = exact({
  kind: Type.Literal("agent"),
  id: Type.String({
    description: "Its ID, which addresses it whatever its name",
  }),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  ...stalledField,
  graph: Type.Optional(Type.String({ description: "The graph it belongs to" })),
  ...resultFields,
});

export type AgentOutput = Static<typeof AgentOutput>;

const NodeOutput = exact({
  id: Type.String({ description: "The agent's ID" }),
  name: Type.String(),
  after: Type.Array(Type.String(), {
    description: "Agents of the graph it depends on",
  }),
  end: Type.Boolean({
    description: "Nothing waits for it; the graph's result is its result",
  }),
  outcome: StringEnum(NODE_KINDS, {
    description: "How its job in the graph ended, or that it still runs",
  }),
  ...resultFields,
});

/** How a finished graph did, by the agents nothing waits for. */
export const GRAPH_OUTCOMES = [
  "succeeded",
  "partial",
  "failed",
  "stopped",
] as const;

export const GraphOutput = exact({
  kind: Type.Literal("graph"),
  id: Type.String({
    description: "Its ID, which addresses it whatever its name",
  }),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  ...stalledField,
  stopped: Type.Boolean(),
  outcome: Type.Optional(
    StringEnum(GRAPH_OUTCOMES, {
      description:
        "Once it finished: whether all, some, or none of the agents nothing waits for answered, or it was stopped",
    }),
  ),
  agents: Type.Array(NodeOutput),
});

export type GraphOutput = Static<typeof GraphOutput>;

export const StatusOutput = exact({
  agents: Type.Array(AgentOutput),
  graphs: Type.Array(GraphOutput),
});

export type StatusOutput = Static<typeof StatusOutput>;

export const WaitOutput = exact({
  agents: Type.Array(AgentOutput),
  graphs: Type.Array(GraphOutput),
  pending: Type.Array(Type.String(), {
    description: "Names the wait ended before",
  }),
});

export type WaitOutput = Static<typeof WaitOutput>;

/** What a stop stopped. */
export const StopOutput = exact({
  kind: StringEnum(["agent", "graph"] as const),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
});

export type StopOutput = Static<typeof StopOutput>;

/** `result` or `error` from a message body. */
function bodyFields(
  kind: "result" | "error",
  body: string,
): { result?: string; error?: string } {
  return kind === "result" ? { result: body } : { error: body };
}

/** An agent with what its latest turn produced. */
export function agentOutput(
  info: AgentInfo,
  graphName: (graphId: string) => string | undefined,
): AgentOutput {
  const graph = info.graph ? graphName(info.graph) : undefined;
  const { result, error } = turnResult(info);
  return {
    kind: "agent",
    id: info.id,
    name: info.name,
    state: info.state,
    ...(info.state === "working" && info.stalled
      ? { stalled: info.stalled }
      : {}),
    ...(graph ? { graph } : {}),
    ...(error !== undefined
      ? bodyFields("error", error)
      : result !== undefined
        ? bodyFields("result", result)
        : {}),
  };
}

/**
 * A graph with how each agent ended its job in it. An agent may answer
 * again later; its graph keeps the answer to its job.
 */
export function graphOutput(
  graph: GraphInfo,
  lookup: (agentId: string) => AgentInfo | undefined,
): GraphOutput {
  const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
  const outcome = graphOutcome(graph);
  return {
    kind: "graph",
    id: graph.id,
    name: graph.name,
    state: graph.state,
    ...(graph.state === "working" && graph.stalled
      ? { stalled: graph.stalled }
      : {}),
    stopped: graph.stopped,
    ...(outcome ? { outcome } : {}),
    agents: graph.nodes.map((node) => {
      const details = nodeDetails(node, lookup(node.agentId), names);
      return {
        id: node.agentId,
        name: details.name,
        after: details.inputs,
        end: details.end,
        outcome: details.kind,
        ...(details.kind === "answered"
          ? bodyFields("result", details.body)
          : details.kind === "failed"
            ? bodyFields("error", details.body)
            : {}),
      };
    }),
  };
}

/** A finished graph's outcome; undefined while it works. */
export function graphOutcome(
  graph: GraphInfo,
): (typeof GRAPH_OUTCOMES)[number] | undefined {
  if (graph.state === "working") return undefined;
  if (graph.stopped) return "stopped";
  const ends = graph.nodes.filter((node) => node.end);
  const answered = ends.filter(
    (node) =>
      node.outcome?.kind === "answered" &&
      node.outcome.result.stopReason !== "error",
  ).length;
  if (answered === ends.length) return "succeeded";
  return answered > 0 ? "partial" : "failed";
}

/** The name of an agent's graph for scripts; a graph of one agent goes
 * by the agent's name, so it names none. */
export function graphName(graph: GraphInfo | undefined): string | undefined {
  return graph && !graph.single ? graph.name : undefined;
}

/** Looks up what outputs refer to. */
export interface OutputLookup {
  agent: (agentId: string) => AgentInfo | undefined;
  graph: (graphId: string) => GraphInfo | undefined;
}

export function stopOutput(target: Target): StopOutput {
  return {
    kind: target.kind,
    name: target.info.name,
    state: target.info.state,
  };
}

export function statusOutput(
  agents: readonly AgentInfo[],
  graphs: readonly GraphInfo[],
  lookup: OutputLookup,
): StatusOutput {
  return {
    agents: agents.map((info) =>
      agentOutput(info, (id) => graphName(lookup.graph(id))),
    ),
    graphs: graphs.map((graph) => graphOutput(graph, lookup.agent)),
  };
}
