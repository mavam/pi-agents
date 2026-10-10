/**
 * Durable bookkeeping for agents and graphs: session documents keyed by
 * conversation ID and graph task ID. Parent requests form an outbox: a
 * request is recorded before it is submitted with the same request ID, and
 * stays until its result is delivered or consumed by a wait.
 *
 * Parent calls are keyed: a spawn stores its call's key in what it creates,
 * a send uses it as its request ID, and a stop records it, so repeating a
 * call finds what its first run did.
 *
 * Migration: both documents are at version 1. A change to their shape bumps
 * `version` and adds `migrate(value, fromVersion)` to the definition;
 * pi-durable migrates a stored document on its next access. Optional fields
 * that records of earlier versions lack need no migration.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { GraphPolicy } from "./types.js";

export type ParentRequest = {
  message: string;
  whenBusy: "steer" | "followUp";
};

export type AgentRecord = {
  name: string;
  profile: string | null;
  task: string;
  createdAt: number;
  closed: boolean;
  ambientSkills: boolean;
  /** Next parent request number. */
  nextRequest: number;
  /** Undelivered parent requests by request ID. */
  requests: Record<string, ParentRequest>;
  /** Answer entries already delivered, newest last, bounded. */
  delivered: number[];
  /** The graph this agent belongs to, by graph ID; absent when standalone. */
  graph?: string;
  /** Whether the agent can start helpers; absent means it can't. */
  delegate?: boolean;
  /** The key of the parent call that spawned it; absent without one. */
  call?: string;
  /** Keys of recent parent calls that stopped it, newest last, bounded. */
  stops?: string[];
};

export type AgentsState = {
  agents: Record<string, AgentRecord>;
};

export const AgentsDoc = defineDoc<AgentsState>({
  kind: "pi-agents.agents",
  version: 1,
  scope: "session",
  initial: () => ({ agents: {} }),
});

export type GraphNodeRecord = {
  /** The agent's conversation ID. */
  agent: string;
  /** The node task that sends the agent its task. */
  task: number;
  /** Agents whose results this agent receives, by conversation ID. */
  after: string[];
};

export type GraphRecord = {
  name: string;
  policy: GraphPolicy;
  createdAt: number;
  /** In spawn order. */
  nodes: GraphNodeRecord[];
  /** Hidden from the panel; storage keeps it. */
  closed: boolean;
  /** The parent still expects the graph's result. */
  pending: boolean;
  /** Stopped before it finished; absent in records written before. */
  stopped?: boolean;
  /** A delegating agent's helpers: the agent, and the tool call that owns
   * the graph task. Absent for graphs the parent started. */
  owner?: { agent: string; tool: number };
  /** The key of the parent call that spawned it; absent without one. */
  call?: string;
  /** Keys of recent parent calls that stopped it, newest last, bounded. */
  stops?: string[];
};

export type GraphsState = {
  graphs: Record<string, GraphRecord>;
};

export const GraphsDoc = defineDoc<GraphsState>({
  kind: "pi-agents.graphs",
  version: 1,
  scope: "session",
  initial: () => ({ graphs: {} }),
});

export type ReceiptsState = {
  /** Per delivery a parent call's result carries, the call's key: the
   * parent recognizes the delivery by the call where the result doesn't
   * name it, such as a nested call's, whose result isn't stored. */
  receipts: Record<string, string>;
};

export const ReceiptsDoc = defineDoc<ReceiptsState>({
  kind: "pi-agents.receipts",
  version: 1,
  scope: "session",
  initial: () => ({ receipts: {} }),
});

/** How many delivered answer IDs a record remembers for deduplication. */
export const DELIVERED_MEMORY = 64;

/*
 * The identities of deliveries to the parent, derived from stored records
 * so they stay the same across restarts. The creation time keeps them
 * unique across stores: a Pi session forked from another copies its
 * messages, while its agents start over in a new store with the same IDs.
 */

export function graphDeliveryId(graphId: string, record: GraphRecord): string {
  return `graph:${graphId}@${record.createdAt}`;
}

/** One answer, which delivers once for every request it answered. */
export function answerDeliveryId(
  agentId: string,
  record: AgentRecord,
  entryId: number,
): string {
  return `agent:${agentId}@${record.createdAt}:entry:${entryId}`;
}

/** One failed request. */
export function failureDeliveryId(
  agentId: string,
  record: AgentRecord,
  requestId: string,
): string {
  return `agent:${agentId}@${record.createdAt}:request:${requestId}`;
}

/** How many stopping calls a record remembers. */
export const STOP_MEMORY = 16;

/** A parent request without a call: numbered per agent. */
export function requestId(index: number): string {
  return `parent:${index}`;
}

/** A parent request of a call: keyed by the call. */
export function callRequestId(call: string): string {
  return `call:${call}`;
}

/** The record a parent call created, by ID. */
export function createdBy(
  records: Readonly<Record<string, { call?: string }>>,
  call: string,
): string | undefined {
  return Object.entries(records).find(
    ([, record]) => record.call === call,
  )?.[0];
}

/** The record a parent call stopped, by ID. */
export function stoppedBy(
  records: Readonly<Record<string, { stops?: string[] }>>,
  call: string,
): string | undefined {
  return Object.entries(records).find(([, record]) =>
    record.stops?.includes(call),
  )?.[0];
}

/** `stops` with `call` added, bounded. */
export function withStop(stops: string[] | undefined, call: string): string[] {
  return [...(stops ?? []), call].slice(-STOP_MEMORY);
}
