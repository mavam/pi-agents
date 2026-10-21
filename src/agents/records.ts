/**
 * Durable bookkeeping for agents and graphs: session documents keyed by
 * conversation ID and graph task ID. Parent requests form an outbox: a
 * request is recorded before it is submitted with the same request ID, and
 * stays until its result is delivered or consumed by a wait.
 *
 * Sessions stored by earlier builds may also hold the documents
 * `pi-agents.stops` and `pi-agents.receipts`; nothing reads them.
 *
 * Migration: a change to a document's shape bumps its `version` and adds a
 * step to its `migrate(value, fromVersion)`; pi-durable migrates a stored
 * document on its next access. Optional fields that records of earlier
 * versions lack need no migration. `pi-agents.agents` is at version 2,
 * which renamed each agent's `task` to `job`; `pi-agents.graphs` is at
 * version 1.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { AgentExtensionState } from "../hooks.js";
import type { GraphPolicy } from "./types.js";

export type ParentRequest = {
  message: string;
  whenBusy: "steer" | "followUp";
};

export type AgentRecord = {
  name: string;
  profile: string | null;
  /** The instructions the agent was started with. */
  job: string;
  createdAt: number;
  closed: boolean;
  ambientSkills: boolean;
  /** Immutable, namespaced snapshots supplied by co-loaded extensions. */
  extensionState?: AgentExtensionState;
  /** Next parent request number. */
  nextRequest: number;
  /** Undelivered parent requests by request ID. */
  requests: Record<string, ParentRequest>;
  /** Answer entries already delivered, newest last, bounded. */
  delivered: number[];
  /** The group this agent belongs to, by group ID; absent for agents of
   * earlier builds that the parent started alone. */
  graph?: string;
  /** Whether the agent may spawn agents of its own; absent means it
   * can't. Named after the delegation of earlier builds. */
  delegate?: boolean;
  /** How many agents started this one and its ancestors: 1 for the
   * parent's agents. Absent in records of earlier builds: 1, or 2 for
   * their helpers. */
  depth?: number;
  /** Stopped by the user or the parent, or with an agent above it, until
   * the user or the parent messages it again; other agents can't message
   * it meanwhile. */
  stopped?: boolean;
  /** Its newest entry when the user last interrupted it: results it is
   * owed wait until it answered after it, so they don't restart the work
   * the user stopped. */
  interrupted?: number;
};

export type AgentsState = {
  agents: Record<string, AgentRecord>;
};

export const AgentsDoc = defineDoc<AgentsState>({
  kind: "pi-agents.agents",
  version: 2,
  scope: "session",
  initial: () => ({ agents: {} }),
  migrate: (value) => migrateAgents(value),
});

/** Version 1 called an agent's job its `task`. */
export function migrateAgents(value: Record<string, unknown>): AgentsState {
  const agents = (value.agents ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return {
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, record]) => {
        const { task, ...rest } = record;
        return [id, { job: rest.job ?? task ?? "", ...rest } as AgentRecord];
      }),
    ),
  };
}

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
  /** Stopped before it finished; absent in records written before. Its
   * result still reaches an agent that owns it, but not the parent. */
  stopped?: boolean;
  /** Withdrawn with the work that needed it, such as when its owner was
   * stopped or failed: it stops, and its result reaches nobody. */
  cancelled?: true;
  /** One agent the parent started on its own: the panel and the parent's
   * messages show the agent alone, and only its ID addresses the group. */
  single?: true;
  /**
   * The agent that spawned the group, and the tool call that did, by task
   * ID, so a rerun of the call finds the group. Absent for groups the
   * parent started. Groups of earlier builds' `delegate_graph` lack
   * `spawned`: their tool call owns them and receives their result.
   */
  owner?: GroupOwner;
  /** The owner's entry that presented the result: an input carrying it, or
   * the result of an `agent_wait` call that returned it. */
  presented?: number;
  /** The `agent_wait` call that holds the result while it returns it, by
   * task ID; delivery as input waits until that call ended. */
  claim?: number;
  /** Delivery attempts as input; the next one runs after the owner
   * answered beyond `withdrawn`, its newest entry when an interrupt
   * withdrew the last attempt. */
  attempt?: number;
  withdrawn?: number;
};

export type GroupOwner = {
  agent: string;
  tool: number;
  /** The agent spawned the group with `agent_spawn`: its conversation owns
   * it in the background, and the agent gets its result as input or from
   * `agent_wait`. */
  spawned?: true;
  /** The agent's newest entry when it spawned the group: its answers
   * after it settle the agent's work only once they follow the result. */
  since?: number;
};

/** Whether the group's result goes to the agent that spawned it, as input
 * or through `agent_wait`, rather than to the parent or a tool call. */
export function isSpawned(
  graph: GraphRecord,
): graph is GraphRecord & { owner: GroupOwner & { spawned: true } } {
  return graph.owner?.spawned === true;
}

/** Helpers of earlier builds' `delegate_graph`: private to their agent. */
export function isLegacyHelperGroup(graph: GraphRecord | undefined): boolean {
  return graph?.owner !== undefined && graph.owner.spawned !== true;
}

/** How deep the agent nests: 1 for the parent's agents. */
export function depthOf(
  record: AgentRecord,
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
): number {
  if (record.depth !== undefined) return record.depth;
  const graph = record.graph ? graphs?.[record.graph] : undefined;
  return graph?.owner ? 2 : 1;
}

export type GraphsState = {
  graphs: Record<string, GraphRecord>;
};

export const GraphsDoc = defineDoc<GraphsState>({
  kind: "pi-agents.graphs",
  version: 1,
  scope: "session",
  initial: () => ({ graphs: {} }),
});

/** A message one agent sent another with `agent_send`. */
export type MessageRecord = {
  /** The request ID of the recipient's submission. */
  id: string;
  /** Sender and recipient, by conversation ID. */
  from: string;
  to: string;
  text: string;
  /** Steer a working recipient, or wait until its work ends; absent in
   * records of earlier builds, which steered. */
  mode?: "steer" | "followUp";
  sentAt: number;
  /** Never submitted: the recipient was stopped or gone when the service
   * found the message after a crash. */
  dropped?: true;
};

export type MessagesState = {
  /** Oldest first, at most `MESSAGE_MEMORY`. */
  messages: MessageRecord[];
  /** How many older messages the log dropped. */
  dropped?: number;
};

/** The log of messages between agents, for the UI; delivery doesn't read
 * it. */
export const MessagesDoc = defineDoc<MessagesState>({
  kind: "pi-agents.messages",
  version: 1,
  scope: "session",
  initial: () => ({ messages: [] }),
});

/** How many messages the log keeps. */
export const MESSAGE_MEMORY = 1_000;

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

/** One attempt to hand a group's result to the agent that spawned it. */
export function resultsRequestId(
  graphId: string,
  record: GraphRecord,
  attempt: number,
): string {
  return `results:${graphId}@${record.createdAt}#${attempt}`;
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

/** A parent request: numbered per agent. */
export function requestId(index: number): string {
  return `parent:${index}`;
}
