/**
 * Durable bookkeeping for agents and groups: session documents keyed by
 * conversation ID and group task ID. Parent requests form an outbox: a
 * request is recorded before it is submitted with the same request ID, and
 * stays until its result is delivered or consumed by a wait.
 *
 * Migration: both documents are at version 1. A change to their shape bumps
 * `version` and adds `migrate(value, fromVersion)` to the definition;
 * pi-durable migrates a stored document on its next access.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { GroupPolicy } from "./types.js";

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
  /** The group this agent belongs to, by group ID; absent when standalone. */
  group?: string;
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

export type GroupRecord = {
  name: string;
  policy: GroupPolicy;
  createdAt: number;
  /** Agent conversation IDs, in spawn order. */
  agents: string[];
  /** Turn task IDs, parallel to `agents`. */
  turns: number[];
  /** Hidden from the panel; storage keeps it. */
  closed: boolean;
  /** The parent still expects the group's result. */
  pending: boolean;
};

export type GroupsState = {
  groups: Record<string, GroupRecord>;
};

export const GroupsDoc = defineDoc<GroupsState>({
  kind: "pi-agents.groups",
  version: 1,
  scope: "session",
  initial: () => ({ groups: {} }),
});

/** How many delivered answer IDs a record remembers for deduplication. */
export const DELIVERED_MEMORY = 64;

export function requestId(index: number): string {
  return `parent:${index}`;
}
