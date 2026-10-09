/**
 * What scripts get from the agent tools: names, states, and results as
 * plain data. Codemode hands a script a tool's structured content and turns
 * its output schema into a declaration. The model still reads the text;
 * results keep the same limit as there.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TProperties, Type } from "typebox";
import { cutResult, NODE_KINDS, turnResult } from "../agents/report.js";
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

/** A result cut to the limit of the text the model reads. */
const resultFields = {
  result: Type.Optional(
    Type.String({
      description:
        "Its answer, or what it wrote before it was interrupted; absent while it works",
    }),
  ),
  error: Type.Optional(Type.String({ description: "Why it failed" })),
  truncated: Type.Optional(
    Type.Boolean({ description: "The result or error was cut to fit" }),
  ),
};

export const AgentOutput = exact({
  kind: Type.Literal("agent"),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  graph: Type.Optional(Type.String({ description: "The graph it belongs to" })),
  ...resultFields,
});

export type AgentOutput = Static<typeof AgentOutput>;

const NodeOutput = exact({
  name: Type.String(),
  after: Type.Array(Type.String(), {
    description: "Agents of the graph it depends on",
  }),
  end: Type.Boolean({
    description: "Nothing waits for it; the graph's result is its result",
  }),
  outcome: StringEnum(NODE_KINDS, {
    description: "How its task in the graph ended, or that it still runs",
  }),
  ...resultFields,
});

export const GraphOutput = exact({
  kind: Type.Literal("graph"),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  stopped: Type.Boolean(),
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
): { result?: string; error?: string; truncated?: boolean } {
  const { text, omitted } = cutResult(body);
  const truncated = omitted > 0 ? { truncated: true } : {};
  return kind === "result"
    ? { result: text, ...truncated }
    : { error: text, ...truncated };
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
    name: info.name,
    state: info.state,
    ...(graph ? { graph } : {}),
    ...(error !== undefined
      ? bodyFields("error", error)
      : result !== undefined
        ? bodyFields("result", result)
        : {}),
  };
}

/**
 * A graph with how each agent ended its task in it. An agent may answer
 * again later; its graph keeps the answer to its task.
 */
export function graphOutput(
  graph: GraphInfo,
  lookup: (agentId: string) => AgentInfo | undefined,
): GraphOutput {
  const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
  return {
    kind: "graph",
    name: graph.name,
    state: graph.state,
    stopped: graph.stopped,
    agents: graph.nodes.map((node) => {
      const details = nodeDetails(node, lookup(node.agentId), names);
      return {
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
      agentOutput(info, (id) => lookup.graph(id)?.name),
    ),
    graphs: graphs.map((graph) => graphOutput(graph, lookup.agent)),
  };
}
