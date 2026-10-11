/**
 * Projection: derives agent and graph infos from stored records and the
 * harness, and keeps settled outcomes of undelivered parent requests.
 */

import {
  AgentDoc,
  type AgentState as DurableAgentState,
  type Harness,
  LiveDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { CONTEXT, conversationId } from "./context.js";
import { DELEGATE_TOOL } from "./delegation.js";
import {
  activityOf,
  addPartialUsage,
  deriveGraphState,
  deriveState,
  resultOf,
  summarizeUsage,
  sumUsage,
} from "./derive.js";
import { type NodeResult, nodeRequestId } from "./graphs.js";
import type { HarnessObserver } from "./observer.js";
import {
  type AgentRecord,
  answerDeliveryId,
  type GraphNodeRecord,
  type GraphRecord,
  graphDeliveryId,
  requestId,
} from "./records.js";
import type { AgentStore } from "./store.js";
import { endNodes, stages } from "./topology.js";
import {
  type AgentInfo,
  type AgentResult,
  type GraphInfo,
  type GraphNode,
  isThinkingLevel,
  type NodeOutcome,
  type RequestOutcome,
} from "./types.js";

/** The graph ended and every agent's job has an outcome. */
export function isSettled(
  info: GraphInfo,
): info is GraphInfo & { nodes: Array<GraphNode & { outcome: NodeOutcome }> } {
  return (
    info.state !== "working" &&
    info.nodes.every((node) => node.outcome !== undefined)
  );
}

export class Projection {
  private records: Record<string, AgentRecord> = {};
  private graphRecords: Record<string, GraphRecord> = {};
  private readonly agentInfos = new Map<string, AgentInfo>();
  private readonly graphInfoById = new Map<string, GraphInfo>();
  /** Settled outcomes of undelivered parent requests, per agent. */
  private readonly settled = new Map<string, Map<string, RequestOutcome>>();
  private readonly harness: Harness;
  private readonly store: AgentStore;
  private readonly observer: HarnessObserver;
  private readonly carried: (deliveryId: string) => boolean;

  constructor(options: {
    harness: Harness;
    store: AgentStore;
    observer: HarnessObserver;
    /** Whether a delivery is in flight and carried by a wait's result. */
    carried: (deliveryId: string) => boolean;
  }) {
    this.harness = options.harness;
    this.store = options.store;
    this.observer = options.observer;
    this.carried = options.carried;
  }

  agents(): Readonly<Record<string, AgentRecord>> {
    return this.records;
  }

  graphs(): Readonly<Record<string, GraphRecord>> {
    return this.graphRecords;
  }

  info(id: string): AgentInfo | undefined {
    return this.agentInfos.get(id);
  }

  graphInfo(id: string): GraphInfo | undefined {
    return this.graphInfoById.get(id);
  }

  infos(): Iterable<AgentInfo> {
    return this.agentInfos.values();
  }

  graphInfos(): Iterable<GraphInfo> {
    return this.graphInfoById.values();
  }

  settledOf(agentId: string): Map<string, RequestOutcome> | undefined {
    return this.settled.get(agentId);
  }

  settledIds(): Iterable<string> {
    return this.settled.keys();
  }

  clearSettled(agentId: string): void {
    this.settled.delete(agentId);
  }

  deleteSettled(agentId: string, rid: string): void {
    this.settled.get(agentId)?.delete(rid);
  }

  async reload(): Promise<void> {
    this.records = await this.store.loadAgents();
    this.graphRecords = await this.store.loadGraphs();
  }

  async refresh(
    ids: string[],
  ): Promise<{ drops: Array<[string, string[]]>; stopped: string[] }> {
    const targets = new Set(ids);
    for (const id of Object.keys(this.records))
      if (!this.agentInfos.has(id)) targets.add(id);
    const drops: Array<[string, string[]]> = [];
    for (const id of targets) {
      const record = this.records[id];
      if (!record) continue;
      drops.push([id, await this.compute(id, record)]);
    }
    const stopped = await this.computeGraphs();
    return { drops, stopped };
  }

  markClosed(graphIds: readonly string[]): void {
    for (const id of graphIds) {
      const info = this.graphInfoById.get(id);
      if (info) info.closed = true;
      for (const node of this.graphRecords[id]?.nodes ?? []) {
        const agent = this.agentInfos.get(node.agent);
        const record = this.records[node.agent];
        if (agent && record) agent.closed = record.closed;
      }
    }
  }

  /** A graph agent's own results wait while its graph's result is due. */
  isHeldByGraph(record: AgentRecord): boolean {
    return (
      record.graph !== undefined &&
      this.graphRecords[record.graph]?.pending === true
    );
  }

  graphOfNode(task: number): GraphRecord | undefined {
    return Object.values(this.graphRecords).find((graph) =>
      graph.nodes.some((node) => node.task === task),
    );
  }

  /** The agents and the helpers they started. */
  withHelpers(ids: string[]): string[] {
    const all = new Set(ids);
    for (const graph of Object.values(this.graphRecords))
      if (graph.owner && all.has(graph.owner.agent))
        for (const node of graph.nodes) all.add(node.agent);
    return [...all];
  }

  /** Recompute one agent's info; returns aborted request IDs to drop. */
  private async compute(id: string, record: AgentRecord): Promise<string[]> {
    const cid = conversationId(id);
    const [live, usage, agent] = await Promise.all([
      this.harness.snapshot(LiveDoc, cid, CONTEXT),
      this.harness.snapshot(UsageDoc, cid, CONTEXT),
      this.harness.snapshot(AgentDoc, cid, CONTEXT),
    ]);
    const outcomes = new Map<string, RequestOutcome>();
    const aborted: string[] = [];
    for (const rid of Object.keys(record.requests)) {
      const outcome = await this.store.requestOutcome(id, record.name, rid);
      if (!outcome) continue;
      if (outcome.kind === "aborted") aborted.push(rid);
      else if (
        outcome.kind === "answered" &&
        record.delivered.includes(outcome.result.entryId)
      )
        aborted.push(rid);
      else outcomes.set(rid, outcome);
    }
    if (outcomes.size > 0) this.settled.set(id, outcomes);
    else this.settled.delete(id);

    const jobAnswer = await this.jobAnswer(id, record);
    const result: AgentResult | undefined = resultOf(
      this.observer.lastAssistantOf(id),
      id,
      record.name,
    );
    const state =
      (live?.run === undefined
        ? await this.nodeState(id, record, result)
        : undefined) ??
      deriveState(live, result, this.observer.settlementOf(id));
    const ended = this.observer.endedTurnOf(id);
    const previous = this.agentInfos.get(id);
    const now = Date.now();
    const endedAt =
      state === "working" || state === "waiting"
        ? undefined
        : await this.agentEndedAt(id, record);
    const durable = (agent ?? {}) as DurableAgentState;
    const tools = Array.isArray(durable.tools)
      ? durable.tools.filter((tool) => tool !== DELEGATE_TOOL)
      : undefined;
    this.agentInfos.set(id, {
      id,
      name: record.name,
      ...(record.profile ? { profile: record.profile } : {}),
      job: record.job,
      cwd: durable.cwd ?? process.cwd(),
      ...(durable.model ? { model: { ...durable.model } } : {}),
      ...(isThinkingLevel(durable.thinkingLevel)
        ? { thinking: durable.thinkingLevel }
        : {}),
      ...(tools ? { tools: [...tools] } : {}),
      state,
      closed: record.closed,
      createdAt: record.createdAt,
      stateSince:
        previous?.state === state
          ? previous.stateSince
          : previous
            ? now
            : state === "working"
              ? record.createdAt
              : (result?.at ?? record.createdAt),
      lastActivityAt:
        this.observer.activityAtOf(id) ??
        previous?.lastActivityAt ??
        record.createdAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      usage: addPartialUsage(summarizeUsage(usage), live),
      activity: activityOf(live),
      ...(result ? { result } : {}),
      ...(ended && (state === "interrupted" || state === "failed")
        ? {
            unanswered: {
              reason: ended.reason,
              ...(ended.detail !== undefined ? { detail: ended.detail } : {}),
              current:
                result !== undefined &&
                ended.since !== undefined &&
                result.entryId > ended.since,
            },
          }
        : {}),
      ...(jobAnswer !== undefined ? { jobAnswer } : {}),
      ...(record.graph ? { graph: record.graph } : {}),
      ...(record.delegate ? { delegates: true } : {}),
      ...(state === "idle" &&
      [...outcomes.values()].some(
        (outcome) =>
          outcome.kind === "answered" &&
          !this.carried(answerDeliveryId(id, record, outcome.result.entryId)),
      )
        ? { queued: true }
        : {}),
    });
    return aborted;
  }

  /**
   * When the agent's latest run ended: when its latest generation became
   * terminal. A graph's agent that never ran ended with its node.
   */
  private async agentEndedAt(
    agentId: string,
    record: AgentRecord,
  ): Promise<number | undefined> {
    const latest = await this.observer.latestGeneration(agentId);
    if (latest) return latest.endedAt;
    const graph =
      record.graph === undefined ? undefined : this.graphRecords[record.graph];
    const node = graph?.nodes.find((each) => each.agent === agentId);
    return node
      ? (await this.observer.settledTask(node.task))?.endedAt
      : undefined;
  }

  /**
   * The entry that answered the agent's job: the answer to the submission
   * of its job, under `parent:1` for agents the parent started and under
   * its node's request ID for a graph's agents.
   */
  private async jobAnswer(
    agentId: string,
    record: AgentRecord,
  ): Promise<number | undefined> {
    const graph =
      record.graph === undefined ? undefined : this.graphRecords[record.graph];
    const node = graph?.nodes.find((each) => each.agent === agentId);
    const rid = node ? nodeRequestId(node.task) : requestId(1);
    return this.observer.jobAnswer(agentId, rid);
  }

  /**
   * A graph agent's state while its own conversation doesn't run: it waits
   * until its inputs ended, then works until its node ended, also before the
   * node sent the job. An agent that never answered shows why: skipped, or
   * stopped by its graph. Undefined when the conversation decides.
   */
  private async nodeState(
    agentId: string,
    record: AgentRecord,
    result: AgentResult | undefined,
  ): Promise<AgentInfo["state"] | undefined> {
    const graph =
      record.graph === undefined ? undefined : this.graphRecords[record.graph];
    const node = graph?.nodes.find((each) => each.agent === agentId);
    if (!graph || !node) return undefined;
    const outcome = await this.observer.taskOutcome(node.task);
    if (outcome === undefined) {
      for (const input of node.after) {
        const task = graph.nodes.find((each) => each.agent === input)?.task;
        if (task !== undefined && !(await this.observer.isFinished(task)))
          return "waiting";
      }
      return "working";
    }
    if (result) return undefined;
    if (
      outcome.status === "completed" &&
      (outcome.result as NodeResult).kind === "skipped"
    )
      return "skipped";
    if (outcome.status === "aborted") return "interrupted";
    return undefined;
  }

  /** How a graph agent's node ended, once it did. */
  private async nodeOutcome(
    task: number,
    agentId: string,
    name: string,
  ): Promise<NodeOutcome | undefined> {
    const outcome = await this.observer.taskOutcome(task);
    if (!outcome) return undefined;
    switch (outcome.status) {
      case "completed": {
        const result = outcome.result as NodeResult;
        if (result.kind === "skipped") return { kind: "skipped" };
        if (result.kind !== "answered") return { kind: "interrupted" };
        const answered = resultOf(
          await this.observer.answer(result.entryId),
          agentId,
          name,
        );
        return answered
          ? { kind: "answered", result: answered }
          : { kind: "failed", reason: "answer missing" };
      }
      case "aborted":
        return { kind: "stopped" };
      case "orphaned":
        return { kind: "failed", reason: outcome.reason };
      default:
        return { kind: "failed", reason: outcome.error.message };
    }
  }

  /** Recompute every graph's info; returns stopped graphs still pending. */
  private async computeGraphs(): Promise<string[]> {
    const stopped: string[] = [];
    const now = Date.now();
    for (const [id, record] of Object.entries(this.graphRecords)) {
      // A graph works until it is terminal, also while it holds an outcome.
      const settled = await this.observer.settledTask(Number(id));
      const ended = settled?.terminal ? settled.outcome : undefined;
      const endedAt = settled?.terminal ? settled.endedAt : undefined;
      const topology = record.nodes.map((node) => ({
        key: node.agent,
        inputs: node.after,
      }));
      const ends = new Set(endNodes(topology));
      const byAgent = new Map<string, GraphNodeRecord>(
        record.nodes.map((node) => [node.agent, node]),
      );
      const nodes: GraphNode[] = [];
      for (const agentId of stages(topology).flat()) {
        const node = byAgent.get(agentId);
        if (!node) continue;
        const name = this.records[agentId]?.name ?? agentId;
        const outcome = await this.nodeOutcome(node.task, agentId, name);
        nodes.push({
          agentId,
          name,
          inputs: [...node.after],
          end: ends.has(agentId),
          ...(outcome ? { outcome } : {}),
        });
      }
      const isStopped =
        ended !== undefined &&
        (record.stopped === true || ended.status === "aborted");
      const state = isStopped ? "interrupted" : deriveGraphState(ended, nodes);
      if (isStopped && record.pending) stopped.push(id);
      const previous = this.graphInfoById.get(id);
      this.graphInfoById.set(id, {
        id,
        name: record.name,
        policy: record.policy,
        state,
        closed: record.closed,
        stopped: isStopped,
        createdAt: record.createdAt,
        stateSince:
          previous?.state === state
            ? previous.stateSince
            : previous
              ? now
              : record.createdAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        nodes,
        usage: sumUsage(
          record.nodes.flatMap((node) => {
            const usage = this.agentInfos.get(node.agent)?.usage;
            return usage ? [usage] : [];
          }),
        ),
        ...(record.owner ? { owner: record.owner.agent } : {}),
        ...(record.pending &&
        ended !== undefined &&
        !isStopped &&
        !this.carried(graphDeliveryId(id, record))
          ? { queued: true }
          : {}),
      });
    }
    this.deriveDelegation();
    return stopped;
  }

  /**
   * What delegation adds to the derived infos: a graph's usage includes the
   * helpers its agents started, and an agent that waits for helpers shows
   * their progress instead of its tool.
   */
  private deriveDelegation(): void {
    const owned = new Map<string, GraphInfo[]>();
    for (const graph of this.graphInfoById.values())
      if (graph.owner)
        owned.set(graph.owner, [...(owned.get(graph.owner) ?? []), graph]);
    for (const graph of this.graphInfoById.values()) {
      if (graph.owner) continue;
      const nested = graph.nodes.flatMap(
        (node) => owned.get(node.agentId) ?? [],
      );
      if (nested.length > 0)
        graph.usage = sumUsage([
          graph.usage,
          ...nested.map((each) => each.usage),
        ]);
    }
    for (const info of this.agentInfos.values()) {
      const working = (owned.get(info.id) ?? []).find(
        (graph) => graph.state === "working",
      );
      const { delegation: _, ...activity } = info.activity;
      if (!working) {
        info.activity = activity;
        continue;
      }
      if (activity.tool === DELEGATE_TOOL) delete activity.tool;
      info.activity = {
        ...activity,
        delegation: {
          graph: working.name,
          done: working.nodes.filter((node) => node.outcome).length,
          total: working.nodes.length,
        },
      };
    }
  }
}
