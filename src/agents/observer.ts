/**
 * HarnessObserver: the commit listener and its per-conversation caches,
 * with cached reads of task outcomes and entries that never change.
 */

import type { JsonValue } from "@earendil-works/chord";
import type {
  CommitPublication,
  EntryRecord,
  Harness,
  SubmissionRecord,
  TaskOutcome,
} from "@earendil-works/pi-durable";
import { CONTEXT, taskId } from "./context.js";
import {
  ASSISTANT_KIND,
  type EndedTurn,
  endedTurnOf,
  GENERATION_KIND,
  settlementOf,
  type TurnSettlement,
} from "./derive.js";
import { GRAPH_TASK, NODE_TASK } from "./graphs.js";
import { isMessageRequest } from "./message-log.js";
import {
  AgentsDoc,
  type GraphRecord,
  GraphsDoc,
  MessagesDoc,
} from "./records.js";
import type { AgentStore } from "./store.js";

interface HarnessObserverOptions {
  harness: Harness;
  store: AgentStore;
  /** The graph record a node task belongs to, for marking its agents dirty. */
  graphOfNode: (task: number) => GraphRecord | undefined;
  /** Something changed; the owner schedules a refresh. */
  onChange: () => void;
  /** A submission with a message request ID was committed. */
  onMessage: (submission: SubmissionRecord) => void;
  /** A document of the message log changed. */
  onMessagesChanged: () => void;
  isMessagesDirty: () => boolean;
  agentIds: () => Iterable<string>;
}

export class HarnessObserver {
  private readonly lastAssistant = new Map<string, EntryRecord>();
  private readonly activityAt = new Map<string, number>();
  private readonly settlements = new Map<string, TurnSettlement>();
  /** Per agent, the latest turn when it ended without an answer. */
  private readonly endedTurns = new Map<string, EndedTurn>();
  /** Per agent, its latest generation task and when it ended, which is when
   * the agent's latest run ended; null when it never ran. */
  private readonly generations = new Map<
    string,
    { task: number; endedAt?: number } | null
  >();
  /** Decided outcomes of graph and node tasks, which never change, whether
   * the task is terminal, which a held outcome is not yet, and when it
   * became terminal. */
  private readonly outcomes = new Map<
    number,
    { outcome: TaskOutcome<JsonValue>; terminal: boolean; endedAt?: number }
  >();
  /** Answer entries of graph agents' jobs; entries never change. */
  private readonly answers = new Map<number, EntryRecord>();
  /** Per agent, the entry that answered its job, or null when the job
   * ended without an answer; settled submissions never change. */
  private readonly jobAnswers = new Map<string, number | null>();
  private readonly dirty = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  private readonly options: HarnessObserverOptions;

  constructor(options: HarnessObserverOptions) {
    this.options = options;
  }

  start(): void {
    this.unsubscribe = this.options.harness.subscribeCommits((publication) =>
      this.onCommit(publication),
    );
  }

  stop(): void {
    this.unsubscribe?.();
  }

  takeDirty(): string[] {
    const ids = [...this.dirty];
    this.dirty.clear();
    return ids;
  }

  markDirty(id: string): void {
    this.dirty.add(id);
  }

  lastAssistantOf(id: string): EntryRecord | undefined {
    return this.lastAssistant.get(id);
  }

  setLastAssistant(id: string, entry: EntryRecord): void {
    this.lastAssistant.set(id, entry);
  }

  async loadLastAssistant(agentId: string): Promise<void> {
    const found = await this.options.store.lastAssistant(agentId);
    if (found) this.lastAssistant.set(agentId, found);
  }

  activityAtOf(id: string): number | undefined {
    return this.activityAt.get(id);
  }

  settlementOf(id: string): TurnSettlement | undefined {
    return this.settlements.get(id);
  }

  endedTurnOf(id: string): EndedTurn | undefined {
    return this.endedTurns.get(id);
  }

  /** Commit listener: record what changed. Must not call Session APIs. */
  private onCommit(publication: CommitPublication): void {
    const now = Date.now();
    let records = false;
    let graphs = false;
    // Turns this commit ended, which may settle several inputs of one run.
    const ended = new Map<string, EndedTurn>();
    for (const change of publication.changes) {
      if (change.type === "document") {
        if (change.record.kind === AgentsDoc.definition.kind) records = true;
        else if (change.record.kind === GraphsDoc.definition.kind)
          graphs = true;
        else if (change.record.kind === MessagesDoc.definition.kind)
          this.options.onMessagesChanged();
        else if (change.conversationId !== undefined)
          this.touch(String(change.conversationId), now);
      } else if (change.type === "entry") {
        const id = String(change.value.conversationId);
        if (change.value.kind === ASSISTANT_KIND)
          this.lastAssistant.set(id, change.value);
        this.touch(id, now);
      } else if (change.type === "submission") {
        const id = String(change.value.conversationId);
        if (isMessageRequest(change.value.requestId))
          this.options.onMessage(change.value);
        const settlement = settlementOf(change.value);
        if (settlement) this.settlements.set(id, settlement);
        const turn = endedTurnOf(change.value, ended.get(id));
        if (turn) ended.set(id, turn);
        else if (settlement === "answered") {
          ended.delete(id);
          this.endedTurns.delete(id);
        }
        this.touch(id, now);
      } else if (change.type === "task") {
        if (change.value.kind === GENERATION_KIND) {
          // Each run, however fast, ends with its latest generation.
          const id = String(change.value.conversationId);
          const task = Number(change.value.id);
          const known = this.generations.get(id);
          if (!known || task >= known.task) {
            const { endedAt } = change.value;
            this.generations.set(id, {
              task,
              ...(endedAt !== undefined ? { endedAt } : {}),
            });
            this.dirty.add(id);
          }
        } else if (change.value.kind === GRAPH_TASK) graphs = true;
        else if (change.value.kind === NODE_TASK) {
          graphs = true;
          // A node's progress changes its agent's state and that of the
          // agents waiting for it.
          const graph = this.options.graphOfNode(Number(change.value.id));
          for (const node of graph?.nodes ?? []) this.dirty.add(node.agent);
        }
      }
    }
    for (const [id, turn] of ended) this.endedTurns.set(id, turn);
    if (records) for (const id of this.options.agentIds()) this.dirty.add(id);
    if (
      records ||
      graphs ||
      this.options.isMessagesDirty() ||
      this.dirty.size > 0
    )
      this.options.onChange();
  }

  private touch(agentId: string, now: number): void {
    this.dirty.add(agentId);
    this.activityAt.set(agentId, now);
  }

  async latestGeneration(
    agentId: string,
  ): Promise<{ task: number; endedAt?: number } | null> {
    let latest = this.generations.get(agentId);
    if (latest === undefined) {
      latest = await this.options.store.latestGeneration(agentId);
      // A commit may have seen a newer generation meanwhile.
      const known = this.generations.get(agentId);
      if (known && (!latest || known.task > latest.task)) latest = known;
      else this.generations.set(agentId, latest);
    }
    return latest;
  }

  /**
   * The entry that answered the agent's job: the answer to the submission
   * of its job, under `parent:1` for agents the parent started and under
   * its node's request ID for a graph's agents.
   */
  async jobAnswer(agentId: string, rid: string): Promise<number | undefined> {
    const cached = this.jobAnswers.get(agentId);
    if (cached !== undefined) return cached ?? undefined;
    const submission = await this.options.store.submission(agentId, rid);
    if (submission?.type !== "input") return undefined;
    if (submission.status === "done") {
      this.jobAnswers.set(agentId, submission.answer);
      return submission.answer;
    }
    if (submission.status === "unanswered") this.jobAnswers.set(agentId, null);
    return undefined;
  }

  /**
   * A task's outcome once decided. A task can hold its outcome while work it
   * owns still runs, such as a user's message to a graph's agent; it is
   * `terminal` only after that work drained.
   */
  async settledTask(
    id: number,
  ): Promise<
    | { outcome: TaskOutcome<JsonValue>; terminal: boolean; endedAt?: number }
    | undefined
  > {
    const cached = this.outcomes.get(id);
    if (cached?.terminal) return cached;
    const record = await this.options.harness.getTask(taskId(id), CONTEXT);
    if (!record)
      return {
        outcome: { status: "faulted", error: { message: "task missing" } },
        terminal: true,
      };
    const state = record.state;
    if (state.status !== "completing" && state.status !== "terminal")
      return undefined;
    const settled = {
      outcome: state.outcome as TaskOutcome<JsonValue>,
      terminal: state.status === "terminal",
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    };
    this.outcomes.set(id, settled);
    return settled;
  }

  /** A task's outcome once decided, even while it is held. */
  async taskOutcome(id: number): Promise<TaskOutcome<JsonValue> | undefined> {
    return (await this.settledTask(id))?.outcome;
  }

  /** Whether a task finished: terminal, with nothing below it running. */
  async isFinished(id: number): Promise<boolean> {
    return (await this.settledTask(id))?.terminal === true;
  }

  async answer(entryId: number): Promise<EntryRecord | undefined> {
    const cached = this.answers.get(entryId);
    if (cached) return cached;
    const entry = await this.options.store.entry(entryId);
    if (entry) this.answers.set(entryId, entry);
    return entry;
  }
}
