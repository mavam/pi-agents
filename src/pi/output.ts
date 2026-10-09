/**
 * What scripts get from the agent tools: names, states, and results as
 * plain data. Codemode hands a script a tool's structured content and turns
 * its output schema into a declaration. The model still reads the text;
 * results keep the same limit as there.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { cutResult, NODE_KINDS } from "../agents/report.js";
import {
  AGENT_STATES,
  type AgentInfo,
  type GraphInfo,
  type Target,
} from "../agents/types.js";
import { nodeDetails } from "./messages.js";

/** A result cut to the limit of the text the model reads. */
const resultFields = {
  result: Type.Optional(
    Type.String({ description: "Its final message, once it answered" }),
  ),
  error: Type.Optional(Type.String({ description: "Why it failed" })),
  truncated: Type.Optional(
    Type.Boolean({ description: "The result was cut to fit" }),
  ),
};

export const AgentOutput = Type.Object({
  kind: Type.Literal("agent"),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  graph: Type.Optional(Type.String({ description: "The graph it belongs to" })),
  ...resultFields,
});

export type AgentOutput = Static<typeof AgentOutput>;

const NodeOutput = Type.Object({
  name: Type.String(),
  after: Type.Array(Type.String(), {
    description: "Agents whose results it received",
  }),
  end: Type.Boolean({
    description: "Nothing waits for it; the graph's result is its result",
  }),
  outcome: StringEnum(NODE_KINDS, {
    description: "How its task in the graph ended",
  }),
  ...resultFields,
});

export const GraphOutput = Type.Object({
  kind: Type.Literal("graph"),
  name: Type.String(),
  state: StringEnum(AGENT_STATES),
  stopped: Type.Boolean(),
  agents: Type.Array(NodeOutput),
});

export type GraphOutput = Static<typeof GraphOutput>;

export const StatusOutput = Type.Object({
  agents: Type.Array(AgentOutput),
  graphs: Type.Array(GraphOutput),
});

export type StatusOutput = Static<typeof StatusOutput>;

export const WaitOutput = Type.Object({
  agents: Type.Array(AgentOutput),
  graphs: Type.Array(GraphOutput),
  pending: Type.Array(Type.String(), {
    description: "Names still working when the wait ended",
  }),
});

export type WaitOutput = Static<typeof WaitOutput>;

export const TargetOutput = Type.Union([AgentOutput, GraphOutput]);

export type TargetOutput = Static<typeof TargetOutput>;

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

/**
 * An agent with its latest result. A working agent has none yet, even when
 * it answered before; a failed one has its error instead.
 */
export function agentOutput(
  info: AgentInfo,
  graphName: (graphId: string) => string | undefined,
): AgentOutput {
  const graph = info.graph ? graphName(info.graph) : undefined;
  const result = info.result;
  const body =
    info.state === "failed"
      ? bodyFields("error", result?.errorMessage ?? (result?.text || "unknown"))
      : (info.state === "idle" || info.state === "interrupted") && result
        ? bodyFields("result", result.text)
        : {};
  return {
    kind: "agent",
    name: info.name,
    state: info.state,
    ...(graph ? { graph } : {}),
    ...body,
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

export function targetOutput(
  target: Target,
  lookup: OutputLookup,
): TargetOutput {
  return target.kind === "graph"
    ? graphOutput(target.info, lookup.agent)
    : agentOutput(target.info, (id) => lookup.graph(id)?.name);
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
