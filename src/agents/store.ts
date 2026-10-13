/**
 * AgentStore: commits and snapshots of pi-agents' documents, and the
 * submissions and stored harness records that their bookkeeping needs.
 */

import type {
  EntryRecord,
  Harness,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { CONTEXT, conversationId } from "./context.js";
import {
  ASSISTANT_KIND,
  GENERATION_KIND,
  outcomeOf,
  resumedAnswer,
  type SubmissionOutcome,
} from "./derive.js";
import { messageSubmission } from "./messaging.js";
import {
  type AgentRecord,
  AgentsDoc,
  DELIVERED_MEMORY,
  type GraphRecord,
  GraphsDoc,
  MessagesDoc,
  type MessagesState,
  type ParentRequest,
  requestId,
} from "./records.js";
import {
  AgentError,
  type AgentResult,
  type GraphNode,
  type RequestOutcome,
} from "./types.js";

export class AgentStore {
  private readonly harness: Harness;

  constructor(options: { harness: Harness }) {
    this.harness = options.harness;
  }

  async loadAgents(): Promise<Record<string, AgentRecord>> {
    const state = await this.harness.snapshot(AgentsDoc, CONTEXT);
    return structuredClone(state?.agents ?? {}) as Record<string, AgentRecord>;
  }

  async loadGraphs(): Promise<Record<string, GraphRecord>> {
    const state = await this.harness.snapshot(GraphsDoc, CONTEXT);
    return structuredClone(state?.graphs ?? {}) as Record<string, GraphRecord>;
  }

  async loadMessages(): Promise<Readonly<MessagesState> | undefined> {
    return this.harness.snapshot(MessagesDoc, CONTEXT);
  }

  async submit(
    agentId: string,
    rid: string,
    request: ParentRequest,
  ): Promise<void> {
    const conversation = await this.harness.conversation(
      conversationId(agentId),
      CONTEXT,
    );
    if (!conversation) throw new AgentError(`Agent ${agentId} is missing`);
    await conversation.submit(
      {
        type: "input",
        content: request.message,
        whenBusy: request.whenBusy,
        requestId: rid,
      },
      CONTEXT,
    );
  }

  /** Outbox: submit recorded parent requests that lack their submission. */
  async flushOutbox(agentId: string): Promise<void> {
    const state = await this.harness.snapshot(AgentsDoc, CONTEXT);
    const record = state?.agents[agentId];
    for (const [rid, request] of Object.entries(record?.requests ?? {})) {
      const existing = await this.submission(agentId, rid);
      if (!existing) await this.submit(agentId, rid, request);
    }
  }

  async dropRequests(agentId: string, rids: string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) return;
      for (const rid of rids) delete record.requests[rid];
    }, CONTEXT);
  }

  /**
   * Drop delivered requests. Delivering an answer closes the agent once no
   * parent request remains: it is done. Messaging it later reopens it.
   */
  async removeRequests(
    agentId: string,
    requestIds: string[],
    entryIds: number[],
  ): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) return;
      for (const rid of requestIds) delete record.requests[rid];
      for (const entryId of entryIds) {
        if (record.delivered.includes(entryId)) continue;
        record.delivered.push(entryId);
      }
      if (entryIds.length > 0 && Object.keys(record.requests).length === 0)
        record.closed = true;
      if (record.delivered.length > DELIVERED_MEMORY)
        record.delivered.splice(0, record.delivered.length - DELIVERED_MEMORY);
    }, CONTEXT);
  }

  /** A wait consumed successful answers with no parent requests left. */
  async closeUnrequested(agentIds: readonly string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      for (const id of agentIds) {
        const record = state.agents[id];
        if (record && Object.keys(record.requests).length === 0)
          record.closed = true;
      }
    }, CONTEXT);
  }

  /**
   * A graph's result reached the parent: the graph closes, and so do its
   * agents that answered, never started, or that the graph stopped. Their
   * answers count as delivered, so parent messages answered by the same
   * entry deliver with the graph. Failed and interrupted agents stay open.
   */
  async consumeGraph(
    graphId: string,
    nodes: readonly GraphNode[],
    settledOf: (agentId: string) => Map<string, RequestOutcome> | undefined,
  ): Promise<void> {
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (!graph) return;
      graph.pending = false;
      graph.closed = true;
      const state = await tx.doc(AgentsDoc);
      for (const node of nodes) {
        const record = state.agents[node.agentId];
        const outcome = node.outcome;
        if (!record || !outcome) continue;
        if (outcome.kind === "answered") {
          const entryId = outcome.result.entryId;
          if (!record.delivered.includes(entryId))
            record.delivered.push(entryId);
          if (record.delivered.length > DELIVERED_MEMORY)
            record.delivered.splice(
              0,
              record.delivered.length - DELIVERED_MEMORY,
            );
          for (const [rid, settled] of settledOf(node.agentId) ?? [])
            if (
              settled.kind === "answered" &&
              settled.result.entryId === entryId
            )
              delete record.requests[rid];
        }
        const done =
          outcome.kind === "answered" ||
          outcome.kind === "stopped" ||
          outcome.kind === "skipped";
        if (done && Object.keys(record.requests).length === 0)
          record.closed = true;
      }
    }, CONTEXT);
  }

  /** A stopped graph delivers nothing. */
  async clearPending(graphIds: string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(GraphsDoc);
      for (const id of graphIds) {
        const graph = state.graphs[id];
        if (graph) graph.pending = false;
      }
    }, CONTEXT);
  }

  async closeGraphs(graphIds: readonly string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const graphs = (await tx.doc(GraphsDoc)).graphs;
      const agents = (await tx.doc(AgentsDoc)).agents;
      for (const id of graphIds) {
        const graph = graphs[id];
        if (!graph) continue;
        graph.closed = true;
        for (const node of graph.nodes) {
          const record = agents[node.agent];
          if (record && Object.keys(record.requests).length === 0)
            record.closed = true;
        }
      }
    }, CONTEXT);
  }

  async markStopped(agentId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[agentId];
      if (!record) return;
      record.closed = true;
      record.stopped = true;
      record.requests = {};
    }, CONTEXT);
  }

  async clearStopped(agentId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[agentId];
      if (record) delete record.stopped;
    }, CONTEXT);
  }

  async stopGraph(graphId: string, stopped: boolean): Promise<void> {
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (!graph) return;
      graph.pending = false;
      graph.closed = true;
      // A graph that holds a decided outcome can't become aborted, so the
      // record keeps the stop.
      if (stopped) graph.stopped = true;
    }, CONTEXT);
  }

  async addRequest(
    agentId: string,
    name: string,
    request: ParentRequest,
  ): Promise<string> {
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) throw new AgentError(`Agent ${name} is missing`);
      record.closed = false;
      delete record.stopped;
      const next = requestId(record.nextRequest);
      record.nextRequest += 1;
      record.requests[next] = request;
      return next;
    }, CONTEXT);
  }

  /**
   * Submit logged messages that a crash left without a submission, before
   * the harness resumes their senders. A message for a stopped or missing
   * recipient is dropped instead.
   */
  async flushMessages(): Promise<void> {
    const [log, state] = await Promise.all([
      this.harness.snapshot(MessagesDoc, CONTEXT),
      this.harness.snapshot(AgentsDoc, CONTEXT),
    ]);
    // One read finds the messages a crash left without a submission.
    const candidates = (log?.messages ?? []).filter(
      (message) => !message.dropped,
    );
    if (candidates.length === 0) return;
    const found = await this.submissionsByRequest(candidates);
    const missing = candidates.filter((_, index) => !found[index]);
    const dropped: string[] = [];
    for (const message of missing) {
      const recipient = state?.agents[message.to];
      const conversation = recipient?.stopped
        ? undefined
        : await this.harness.conversation(conversationId(message.to), CONTEXT);
      if (!conversation) {
        dropped.push(message.id);
        continue;
      }
      const sender = state?.agents[message.from]?.name ?? message.from;
      await conversation.submit(messageSubmission(message, sender), CONTEXT);
    }
    if (dropped.length === 0) return;
    await this.harness.commit(async (tx) => {
      for (const known of (await tx.doc(MessagesDoc)).messages)
        if (dropped.includes(known.id)) known.dropped = true;
    }, CONTEXT);
  }

  async requestOutcome(
    agentId: string,
    name: string,
    rid: string,
  ): Promise<SubmissionOutcome | undefined> {
    return this.harness.commit(async (tx) => {
      const submission = await tx.submissionByRequest(
        conversationId(agentId),
        rid,
      );
      const answer =
        submission?.type === "input" && submission.status === "done"
          ? await tx.entry(submission.answer)
          : undefined;
      return outcomeOf(submission, answer, agentId, name);
    }, CONTEXT);
  }

  async submission(
    agentId: string,
    rid: string,
  ): Promise<SubmissionRecord | undefined> {
    return this.harness.commit(
      (tx) => tx.submissionByRequest(conversationId(agentId), rid),
      CONTEXT,
    );
  }

  async submissionsByRequest(
    pairs: ReadonlyArray<{ to: string; id: string }>,
  ): Promise<(SubmissionRecord | undefined)[]> {
    return this.harness.commit(
      (tx) =>
        Promise.all(
          pairs.map((message) =>
            tx.submissionByRequest(conversationId(message.to), message.id),
          ),
        ),
      CONTEXT,
    );
  }

  async entry(entryId: number): Promise<EntryRecord | undefined> {
    return this.harness.commit(
      (tx) => tx.entry(entryId as EntryRecord["id"]),
      CONTEXT,
    );
  }

  async latestGeneration(
    agentId: string,
  ): Promise<{ task: number; endedAt?: number } | null> {
    const [task] = (
      await this.harness.commit(
        (tx) =>
          tx.scanTasks(
            {
              conversationId: conversationId(agentId),
              kind: GENERATION_KIND,
              order: "descending",
            },
            1,
          ),
        CONTEXT,
      )
    ).items;
    return task
      ? {
          task: Number(task.id),
          ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
        }
      : null;
  }

  /** The answer that settles a request interrupted at `since`, if any. */
  async resumedAnswer(
    agentId: string,
    name: string,
    since: number,
  ): Promise<AgentResult | undefined> {
    const conversation = await this.harness.conversation(
      conversationId(agentId),
      CONTEXT,
    );
    if (!conversation) return undefined;
    const entries: EntryRecord[] = [];
    let cursor: Parameters<typeof conversation.entries>[2];
    for (;;) {
      const page = await conversation.entries(
        { minEntryId: since as EntryRecord["id"], order: "ascending" },
        64,
        cursor,
        CONTEXT,
      );
      entries.push(...page.items);
      const found = resumedAnswer(entries, since, agentId, name);
      if (found || page.next === undefined) return found;
      cursor = page.next;
    }
  }

  /** The newest assistant entry, paging newest-first through the conversation. */
  async lastAssistant(agentId: string): Promise<EntryRecord | undefined> {
    const conversation = await this.harness.conversation(
      conversationId(agentId),
      CONTEXT,
    );
    if (!conversation) return;
    let cursor: Parameters<typeof conversation.entries>[2];
    for (;;) {
      const result = await conversation.entries({}, 32, cursor, CONTEXT);
      const found = result.items.find((entry) => entry.kind === ASSISTANT_KIND);
      if (found) return found;
      if (result.next === undefined) return;
      cursor = result.next;
    }
  }
}
