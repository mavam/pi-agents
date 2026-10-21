/**
 * AgentStore: commits and snapshots of pi-agents' documents, and the
 * submissions and stored harness records that their bookkeeping needs.
 */

import type {
  Cursor,
  EntryRecord,
  Harness,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { CONTEXT, conversationId } from "./context.js";
import {
  ASSISTANT_KIND,
  GENERATION_KIND,
  outcomeOf,
  resultOf,
  type SubmissionOutcome,
} from "./derive.js";
import { awaitsJob, messageSubmission } from "./messaging.js";
import {
  coveringAnswer,
  isFinalAnswer,
  type Obligation,
  presentedGroups,
  scanStart,
} from "./obligations.js";
import {
  type AgentRecord,
  AgentsDoc,
  DELIVERED_MEMORY,
  type GraphRecord,
  GraphsDoc,
  isSpawned,
  MessagesDoc,
  type MessagesState,
  type ParentRequest,
  requestId,
  resultsRequestId,
} from "./records.js";
import {
  AgentError,
  type AgentResult,
  type GraphNode,
  type RequestOutcome,
} from "./types.js";

/** The stop fence of agents `roots` and every agent below them, through
 * every group they spawned, finished or not; inside a commit. Their owed
 * results are withdrawn: groups that didn't reach them are cancelled, so
 * nothing they spawn afterwards escapes the stop. Returns the stopped
 * agents, roots first. */
async function fence(tx: Tx, roots: string[]): Promise<string[]> {
  const agents = (await tx.doc(AgentsDoc)).agents;
  const graphs = (await tx.doc(GraphsDoc)).graphs;
  const stopped = [...roots];
  for (let index = 0; index < stopped.length; index++) {
    const owner = stopped[index] as string;
    for (const graph of Object.values(graphs)) {
      if (graph.owner?.agent !== owner) continue;
      if (isSpawned(graph) && !graph.cancelled && graph.presented === undefined)
        graph.cancelled = true;
      for (const node of graph.nodes)
        if (!stopped.includes(node.agent)) stopped.push(node.agent);
    }
  }
  for (const id of stopped) {
    const record = agents[id];
    if (!record) continue;
    record.closed = true;
    record.stopped = true;
    record.requests = {};
  }
  return stopped;
}

/** Why a run's inputs end unanswered when the run failed, rather than
 * being interrupted, reset, or superseded. */
const FAILURES = new Set(["model_error", "no_model"]);

/** The agent's first entry from `from` on that presented the group;
 * inside a commit. */
async function findPresentation(
  tx: Tx,
  agentId: string,
  from: number,
  graphId: string,
): Promise<number | undefined> {
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await tx.scanEntries(
      {
        conversationId: conversationId(agentId),
        minEntryId: from as EntryRecord["id"],
        order: "ascending",
      },
      128,
      cursor,
    );
    const found = page.items.find((entry) =>
      presentedGroups(entry).includes(graphId),
    );
    if (found) return Number(found.id);
    if (page.next === undefined) return undefined;
    cursor = page.next;
  }
}

/** Whether the agent's newest answer finished after `entry`; inside a
 * commit. */
async function answeredSince(
  tx: Tx,
  agentId: string,
  entry: number,
): Promise<boolean> {
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await tx.scanEntries(
      {
        conversationId: conversationId(agentId),
        minEntryId: (entry + 1) as EntryRecord["id"],
        order: "descending",
      },
      32,
      cursor,
    );
    const latest = page.items.find((each) => each.kind === ASSISTANT_KIND);
    if (latest) return isFinalAnswer(latest);
    if (page.next === undefined) return false;
    cursor = page.next;
  }
}

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

  /** Stop the agent and every agent below it in one commit, the stop
   * fence. Returns the stopped agents, the agent first. */
  async markStopped(agentId: string): Promise<string[]> {
    return this.harness.commit(async (tx) => {
      if (!(await tx.doc(AgentsDoc)).agents[agentId]) return [];
      return fence(tx, [agentId]);
    }, CONTEXT);
  }

  /** Withdraw groups whose spawning run failed, even if a retry already
   * answered. Groups of runs that answered or were interrupted, and of
   * other runs, keep going. */
  async cancelFailedGroups(agentId: string): Promise<void> {
    const graphs = (await this.harness.snapshot(GraphsDoc, CONTEXT))?.graphs;
    const failed: string[] = [];
    for (const [id, graph] of Object.entries(graphs ?? {})) {
      const input = graph.owner?.run?.[0];
      if (graph.owner?.agent !== agentId || input === undefined) continue;
      if (graph.cancelled || graph.presented !== undefined) continue;
      const submission = await this.harness.submission(
        input as SubmissionId,
        CONTEXT,
      );
      if (await this.failed(await submission?.status(CONTEXT))) failed.push(id);
    }
    if (failed.length === 0) return;
    await this.harness.commit(async (tx) => {
      const graphs = (await tx.doc(GraphsDoc)).graphs;
      for (const id of failed) {
        const graph = graphs[id];
        if (graph && !graph.cancelled && graph.presented === undefined)
          graph.cancelled = true;
      }
    }, CONTEXT);
  }

  /** Whether the run that settled `record` failed: it ended without an
   * answer, or with an error for one. */
  private async failed(record: SubmissionRecord | undefined): Promise<boolean> {
    if (record?.type !== "input") return false;
    if (record.status === "unanswered") return FAILURES.has(record.reason);
    if (record.status !== "done") return false;
    const answer = (await this.entry(record.answer))?.model?.[0];
    return answer?.role === "assistant" && answer.stopReason === "error";
  }

  /** Whether the agent's graph still waits for the agents its job needs,
   * so its job hasn't reached it. */
  async awaitsJob(agentId: string): Promise<boolean> {
    return this.harness.commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[agentId];
      return record !== undefined && (await awaitsJob(tx, agentId, record));
    }, CONTEXT);
  }

  /** The user interrupted the agent: results it is owed wait until it
   * answered after its newest entry. */
  async markInterrupted(agentId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[agentId];
      if (!record) return;
      const page = await tx.scanEntries(
        { conversationId: conversationId(agentId), order: "descending" },
        1,
      );
      record.interrupted = Number(page.items[0]?.id ?? 0);
      // Capture withdrawal while still in the interrupt's turn, not when
      // refresh eventually notices it after a corrective answer.
      for (const [id, graph] of Object.entries(
        (await tx.doc(GraphsDoc)).graphs,
      )) {
        if (
          graph.owner?.agent !== agentId ||
          graph.attempt === undefined ||
          graph.presented !== undefined ||
          graph.cancelled
        )
          continue;
        const submission = await tx.submissionByRequest(
          conversationId(agentId),
          resultsRequestId(id, graph, graph.attempt),
        );
        if (submission?.status === "unanswered")
          graph.withdrawn = record.interrupted;
      }
    }, CONTEXT);
  }

  /** The owner's entry that presented the group's result. */
  async markPresented(graphId: string, entry: number): Promise<void> {
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (graph && graph.presented === undefined) graph.presented = entry;
    }, CONTEXT);
  }

  /**
   * Reserve the next attempt to hand a group's result to its owner, unless
   * a live `agent_wait` call holds it. Returns the attempt.
   */
  async reserveAttempt(
    graphId: string,
    attempt: number,
  ): Promise<number | undefined> {
    return this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (!graph || graph.presented !== undefined || graph.cancelled)
        return undefined;
      // The owner as it is now: stopped, or interrupted and not answered
      // since, it gets nothing.
      if (isSpawned(graph)) {
        const owner = (await tx.doc(AgentsDoc)).agents[graph.owner.agent];
        if (!owner || owner.stopped) return undefined;
        if (
          owner.interrupted !== undefined &&
          !(await answeredSince(tx, graph.owner.agent, owner.interrupted))
        )
          return undefined;
      }
      if (graph.claim !== undefined) {
        const holder = await tx.task(graph.claim as TaskId);
        if (holder && holder.state.status !== "terminal") return undefined;
        // The call that held the result may have returned it meanwhile;
        // its result entry commits with its end, so this commit sees it.
        if (isSpawned(graph)) {
          const entry = await findPresentation(
            tx,
            graph.owner.agent,
            graph.owner.since ?? 0,
            graphId,
          );
          if (entry !== undefined) {
            graph.presented = entry;
            return undefined;
          }
        }
        delete graph.claim;
      }
      graph.attempt = attempt;
      delete graph.withdrawn;
      return attempt;
    }, CONTEXT);
  }

  /** An interrupt withdrew the attempt; `entry` is the owner's newest. */
  async markWithdrawn(graphId: string, entry: number): Promise<void> {
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (graph && graph.withdrawn === undefined) graph.withdrawn = entry;
    }, CONTEXT);
  }

  /** The owner's first entry from `from` on that presented the group. */
  async presentation(
    agentId: string,
    from: number,
    graphId: string,
  ): Promise<number | undefined> {
    return this.harness.commit(
      (tx) => findPresentation(tx, agentId, from, graphId),
      CONTEXT,
    );
  }

  /** The agent's newest entry. */
  async newestEntry(agentId: string): Promise<number> {
    const page = await this.harness.commit(
      (tx) =>
        tx.scanEntries(
          { conversationId: conversationId(agentId), order: "descending" },
          1,
        ),
      CONTEXT,
    );
    return Number(page.items[0]?.id ?? 0);
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
      // With the stop fence of its agents and theirs, so a crash before
      // they ended can't let them, or what they spawned, resume.
      await fence(
        tx,
        graph.nodes.map((node) => node.agent),
      );
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
      if (await awaitsJob(tx, agentId, record))
        throw new AgentError(
          `${name} waits for the agents its job needs and hasn't started; message it once it works`,
        );
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

  /**
   * The answer that settles a request whose input entered at `since` but
   * that no answer settled yet: it was interrupted, or answered before the
   * results it was owed.
   */
  async coveringAnswer(
    agentId: string,
    name: string,
    since: number,
    obligations: readonly Obligation[],
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
        {
          minEntryId: scanStart(since, obligations) as EntryRecord["id"],
          order: "ascending",
        },
        64,
        cursor,
        CONTEXT,
      );
      entries.push(...page.items);
      const found = resultOf(
        coveringAnswer(entries, since, obligations),
        agentId,
        name,
      );
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
