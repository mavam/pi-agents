/**
 * Receipts: what a tool call did and saw, as plain data that its result
 * stores for display. A result stays in a transcript, so a receipt holds
 * only what stays true: the structure a call started, how agents and graphs
 * were when the call looked at them, and how the call's wait ended. No
 * clocks, no activity, and no markers that change later, such as a result
 * waiting for delivery. Renderers draw receipts and nothing else.
 *
 * Every receipt comes from one observation, made when the call returns or
 * reports progress. Delivery bookkeeping stays out of receipts.
 */

import {
  cutResult,
  type NodeKind,
  nodeResult,
  type ResultLimit,
  turnResult,
} from "./report.js";
import type {
  AgentInfo,
  AgentState,
  AgentUsage,
  GraphInfo,
  ModelRef,
} from "./types.js";

function usageOf(usage: AgentUsage): ReceiptUsage {
  const { input, output, cacheRead, cacheWrite, cost } = usage;
  return { input, output, cacheRead, cacheWrite, cost };
}

export const RECEIPT_VERSION = 1;

/** How a call's wait ended: everything it waited for finished, it timed
 * out, the parent was needed, or the call was cancelled. */
export type WaitEnd = "done" | "timeout" | "attention" | "cancelled";

/** Token counts and cost; a type, unlike `AgentUsage`, so receipts are
 * JSON values. */
export type ReceiptUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type AgentReceipt = {
  name: string;
  profile?: string;
  /** The model ID without its provider. */
  model?: string;
  /** In a graph: the agents whose results it receives, by name. */
  inputs?: string[];
  /** The task it was started with, for agents that look for others. */
  task?: string;
  /** How it was when the call looked; absent when the call only started
   * it. */
  outcome?: NodeKind;
  /** Its usage then, once it finished. */
  usage?: ReceiptUsage;
  /** Its answer or error then, cut for display. */
  body?: string;
};

export type GraphReceipt = {
  name: string;
  /** How it was when the call looked; absent when the call only started
   * it. */
  outcome?: NodeKind;
  /** Its usage then, once it finished. */
  usage?: ReceiptUsage;
  agents: AgentReceipt[];
};

export type ToolReceipt = {
  version: typeof RECEIPT_VERSION;
  graphs: GraphReceipt[];
  /** Agents outside the graphs. */
  agents: AgentReceipt[];
  /** How the call's wait ended; absent when it didn't wait. */
  wait?: WaitEnd;
};

/** How much of an answer a receipt keeps. */
const DISPLAY_LIMIT: ResultLimit = {
  chars: 8_000,
  lines: 200,
  hint: "Attach to the agent to read all of it.",
};

export function receipt(
  parts: Partial<Omit<ToolReceipt, "version">> = {},
): ToolReceipt {
  return { version: RECEIPT_VERSION, graphs: [], agents: [], ...parts };
}

/** Whether an outcome is final. */
export function isFinished(kind: NodeKind | undefined): boolean {
  return kind !== undefined && kind !== "working" && kind !== "waiting";
}

/** An agent's or a graph's state as an outcome. */
export function stateOutcome(state: AgentState): NodeKind {
  return state === "idle" ? "answered" : state;
}

function shortModel(model: ModelRef | undefined): string | undefined {
  return model?.modelId;
}

function cut(body: string): string {
  const { text, omitted } = cutResult(body, DISPLAY_LIMIT);
  return omitted > 0 ? `${text}\n… ${omitted} more characters` : text;
}

/** Who an agent is, without how it does. */
function identity(
  info: Pick<AgentInfo, "name" | "profile" | "model">,
  inputs?: string[],
): AgentReceipt {
  const model = shortModel(info.model);
  return {
    name: info.name,
    ...(info.profile ? { profile: info.profile } : {}),
    ...(model ? { model } : {}),
    ...(inputs && inputs.length > 0 ? { inputs } : {}),
  };
}

/** An agent as a call saw it: its state and its latest turn's answer. */
function observedAgent(info: AgentInfo): AgentReceipt {
  const outcome = stateOutcome(info.state);
  const { result, error } = turnResult(info);
  const body = error ?? result;
  return {
    ...identity(info),
    outcome,
    ...(isFinished(outcome) ? { usage: usageOf(info.usage) } : {}),
    ...(body ? { body: cut(body) } : {}),
  };
}

type AgentLookup = (agentId: string) => AgentInfo | undefined;

/** A graph's agents: who they are and, when `observe`, how they did their
 * task. */
function graphAgents(
  graph: GraphInfo,
  lookup: AgentLookup,
  observe: boolean,
): AgentReceipt[] {
  const names = new Map(graph.nodes.map((node) => [node.agentId, node.name]));
  return graph.nodes.map((node) => {
    const info = lookup(node.agentId);
    const inputs = node.inputs.map((input) => names.get(input) ?? input);
    const base = identity(
      { name: node.name, profile: info?.profile, model: info?.model },
      inputs,
    );
    if (!observe) return base;
    const { kind, body } = nodeResult(node, info?.state);
    return {
      ...base,
      outcome: kind,
      ...(isFinished(kind) && info ? { usage: usageOf(info.usage) } : {}),
      ...(body ? { body: cut(body) } : {}),
    };
  });
}

/** A graph as a call started it: its agents and who waits for whom. */
export function startedGraph(
  graph: GraphInfo,
  lookup: AgentLookup,
): GraphReceipt {
  return { name: graph.name, agents: graphAgents(graph, lookup, false) };
}

/** A graph as a call saw it: how it and each agent did its task. */
function observedGraph(graph: GraphInfo, lookup: AgentLookup): GraphReceipt {
  const outcome = graph.stopped ? "stopped" : stateOutcome(graph.state);
  return {
    name: graph.name,
    outcome,
    ...(isFinished(outcome) ? { usage: usageOf(graph.usage) } : {}),
    agents: graphAgents(graph, lookup, true),
  };
}

/** Graphs and agents as a call saw them; agents of the graphs show below
 * their graph only. */
export function observed(
  graphs: readonly GraphInfo[],
  agents: readonly AgentInfo[],
  lookup: AgentLookup,
  wait?: WaitEnd,
): ToolReceipt {
  const inGraphs = new Set(
    graphs.flatMap((graph) => graph.nodes.map((node) => node.agentId)),
  );
  return receipt({
    graphs: graphs.map((graph) => observedGraph(graph, lookup)),
    agents: agents.filter((info) => !inGraphs.has(info.id)).map(observedAgent),
    ...(wait ? { wait } : {}),
  });
}

/**
 * A finished graph's outcome from its agents nothing waits for: `failed`
 * when one failed or was skipped, `interrupted` when one didn't answer
 * otherwise, and `answered` when they all answered.
 */
export function endsOutcome(ends: readonly (NodeKind | undefined)[]): NodeKind {
  if (ends.some((kind) => kind === "failed" || kind === "skipped"))
    return "failed";
  if (ends.some((kind) => kind !== "answered")) return "interrupted";
  return "answered";
}

/** A stored receipt, if `value` is one this version reads. */
export function asReceipt(value: unknown): ToolReceipt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<ToolReceipt>;
  return candidate.version === RECEIPT_VERSION &&
    Array.isArray(candidate.graphs) &&
    Array.isArray(candidate.agents)
    ? (candidate as ToolReceipt)
    : undefined;
}
