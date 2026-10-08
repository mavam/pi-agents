/**
 * Durable bookkeeping for agents and graphs: session documents keyed by
 * conversation ID and graph task ID. Parent requests form an outbox: a
 * request is recorded before it is submitted with the same request ID, and
 * stays until its result is delivered or consumed by a wait.
 *
 * Migration: both documents are at version 1. A change to their shape bumps
 * `version` and adds `migrate(value, fromVersion)` to the definition;
 * pi-durable migrates a stored document on its next access.
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

/** How many delivered answer IDs a record remembers for deduplication. */
export const DELIVERED_MEMORY = 64;

export function requestId(index: number): string {
  return `parent:${index}`;
}
