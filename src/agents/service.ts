/**
 * AgentService: the agent abstraction over one pi-durable Harness. Agents are
 * ownerless conversations, so aborting other work never reaches them. The
 * service keeps a derived `AgentInfo` per agent, refreshed from commit
 * publications, and tracks parent requests until they are delivered.
 */

import type { AttachedReplicatedState, Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type CommitPublication,
  type ConversationId,
  type ConversationView,
  createRegistry,
  type AgentState as DurableAgentState,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  LiveDoc,
  type Registry,
  type Storage,
  type ToolRegistration,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { ExecutionEnvs } from "../host/env.js";
import { DEFAULT_AGENT_TOOLS, TOOLS_EXTENSION } from "../host/tools.js";
import {
  ASSISTANT_KIND,
  activityOf,
  addPartialUsage,
  deriveState,
  outcomeOf,
  resultOf,
  settlementOf,
  summarizeUsage,
  type TurnSettlement,
} from "./derive.js";
import {
  type AgentRecord,
  AgentsDoc,
  DELIVERED_MEMORY,
  type ParentRequest,
  requestId,
} from "./records.js";
import {
  AgentError,
  type AgentInfo,
  type AgentResult,
  isThinkingLevel,
  type PendingDelivery,
  type RequestOutcome,
  type SendMode,
  type SpawnSpec,
} from "./types.js";

const CONTEXT = BACKGROUND_CONTEXT;
const REFRESH_DELAY_MS = 50;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export interface AgentServiceOptions {
  storage: Storage;
  models: Models;
  /** Fallback working directory for agents without one. */
  cwd: string;
  /** Installed extensions; also the default selection of every agent. */
  extensions: Extension[];
  settings?: HarnessSettings;
  now?: () => number;
  onReport?: (error: unknown) => void;
}

export interface WaitOutcome {
  agents: AgentInfo[];
  /** Agents still working when the wait timed out. */
  timedOut: string[];
}

function conversationId(agentId: string): ConversationId {
  return Number(agentId) as ConversationId;
}

function contextFor(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, CONTEXT) : CONTEXT;
}

export function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export class AgentService {
  private records: Record<string, AgentRecord> = {};
  private readonly infos = new Map<string, AgentInfo>();
  /** Settled outcomes of undelivered parent requests, per agent. */
  private readonly settled = new Map<string, Map<string, RequestOutcome>>();
  private readonly lastAssistant = new Map<string, EntryRecord>();
  private readonly activityAt = new Map<string, number>();
  private readonly settlements = new Map<string, TurnSettlement>();
  private readonly waiters = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly dirty = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private readonly now: () => number;

  private constructor(
    private readonly harness: Harness,
    private readonly registry: Registry,
    private readonly envs: ExecutionEnvs,
    now: (() => number) | undefined,
  ) {
    this.now = now ?? Date.now;
  }

  static async open(options: AgentServiceOptions): Promise<AgentService> {
    const registry = createRegistry();
    for (const extension of options.extensions) registry.install(extension);
    const envs = new ExecutionEnvs(options.cwd);
    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        settings: { ...options.settings, extensions: options.extensions },
        env: envs.env,
        ...(options.now ? { now: options.now } : {}),
        ...(options.onReport ? { onReport: options.onReport } : {}),
      },
      CONTEXT,
    );
    const service = new AgentService(harness, registry, envs, options.now);
    try {
      await service.start();
    } catch (error) {
      await service.close();
      throw error;
    }
    return service;
  }

  // --- Lifecycle ---

  private async start(): Promise<void> {
    this.unsubscribe = this.harness.subscribeCommits((publication) =>
      this.onCommit(publication),
    );
    this.records = await this.loadRecords();
    for (const [id, record] of Object.entries(this.records)) {
      await this.loadLastAssistant(id);
      if (record.closed) continue;
      // Outbox: a request recorded before a crash may lack its submission.
      for (const [rid, request] of Object.entries(record.requests)) {
        const existing = await this.harness.commit(
          (tx) => tx.submissionByRequest(conversationId(id), rid),
          CONTEXT,
        );
        if (!existing) await this.submit(id, rid, request);
      }
    }
    // Continue work that a previous process left unfinished.
    this.harness.resume();
    await this.refresh(Object.keys(this.records));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.listeners.clear();
    await this.refreshChain.catch(() => {});
    await this.harness.close(CONTEXT);
    await this.envs.cleanup(CONTEXT);
  }

  // --- Observation ---

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Open agents first by default; closed agents only on request. */
  list(options: { includeClosed?: boolean } = {}): AgentInfo[] {
    return [...this.infos.values()]
      .filter((info) => options.includeClosed || !info.closed)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(nameOrId: string): AgentInfo | undefined {
    const open = this.list().find((info) => info.name === nameOrId);
    return open ?? this.infos.get(nameOrId);
  }

  private require(nameOrId: string): AgentInfo {
    const info = this.get(nameOrId);
    if (!info) throw new AgentError(`No agent named ${nameOrId}`);
    return info;
  }

  private requireOpen(nameOrId: string): AgentInfo {
    const info = this.require(nameOrId);
    if (info.closed) throw new AgentError(`Agent ${info.name} is closed`);
    return info;
  }

  /** The agent's live durable conversation view, for the attach view. */
  async view(
    nameOrId: string,
  ): Promise<AttachedReplicatedState<ConversationView>> {
    const info = this.require(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    if (!conversation) throw new AgentError(`Agent ${info.name} is missing`);
    return conversation.viewState(CONTEXT);
  }

  /** Whether a wait currently covers the agent. */
  isAwaited(agentId: string): boolean {
    return (this.waiters.get(agentId) ?? 0) > 0;
  }

  // --- Operations ---

  async spawn(spec: SpawnSpec): Promise<AgentInfo> {
    const name = spec.name?.trim() || this.generateName(spec.profile);
    if (!isValidAgentName(name))
      throw new AgentError(
        `Invalid agent name "${name}": use letters, digits, '.', '_', or '-' (at most 48 characters)`,
      );
    if (this.list().some((info) => info.name === name))
      throw new AgentError(`An agent named ${name} already exists`);
    if (spec.thinking !== undefined && !isThinkingLevel(spec.thinking))
      throw new AgentError(`Invalid thinking level: ${spec.thinking}`);
    const tools = this.resolveTools(spec.tools);
    const task = spec.task.trim();
    if (!task) throw new AgentError("The task must not be empty");
    const first = requestId(1);
    const request: ParentRequest = { message: task, whenBusy: "followUp" };
    const createdAt = this.now();
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          cwd: spec.cwd,
          tools,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        },
        init: async (tx, id) => {
          const state = await tx.doc(AgentsDoc);
          state.agents[String(id)] = {
            name,
            profile: spec.profile ?? null,
            task,
            createdAt,
            closed: false,
            ambientSkills: spec.ambientSkills ?? true,
            nextRequest: 2,
            requests: { [first]: request },
            delivered: [],
          };
        },
      },
      CONTEXT,
    );
    const id = String(conversation.id);
    await this.submit(id, first, request);
    await this.refresh([id]);
    return this.require(id);
  }

  /** Message an agent on behalf of the parent model. */
  async send(nameOrId: string, message: string, mode: SendMode): Promise<void> {
    const info = this.requireOpen(nameOrId);
    const text = message.trim();
    if (!text) throw new AgentError("The message must not be empty");
    const request: ParentRequest = {
      message: text,
      whenBusy: mode === "followUp" ? "followUp" : "steer",
    };
    const rid = await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[info.id];
      if (!record) throw new AgentError(`Agent ${info.name} is missing`);
      const next = requestId(record.nextRequest);
      record.nextRequest += 1;
      record.requests[next] = request;
      return next;
    }, CONTEXT);
    await this.submit(info.id, rid, request);
    await this.refresh([info.id]);
  }

  /** Message an agent on behalf of the user; results stay in the agent. */
  async prompt(nameOrId: string, text: string, mode: SendMode): Promise<void> {
    const info = this.requireOpen(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    if (!conversation) throw new AgentError(`Agent ${info.name} is missing`);
    await conversation.submit(
      {
        type: "input",
        content: text,
        whenBusy: mode === "followUp" ? "followUp" : "steer",
      },
      CONTEXT,
    );
  }

  /** Abort the agent's current work and withdraw its queued messages. */
  async stop(nameOrId: string): Promise<void> {
    const info = this.require(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    await conversation?.abort(CONTEXT);
    await this.refresh([info.id]);
  }

  /** Stop the agent and hide it. Storage keeps its conversation. */
  async closeAgent(nameOrId: string): Promise<void> {
    const info = this.requireOpen(nameOrId);
    await this.stop(info.id);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[info.id];
      if (!record) return;
      record.closed = true;
      record.requests = {};
    }, CONTEXT);
    this.settled.delete(info.id);
    await this.refresh([info.id]);
  }

  /**
   * Wait until the agents are idle and return them. Results of their settled
   * parent requests count as delivered. Aborting `signal` ends only the wait.
   */
  async wait(
    names: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<WaitOutcome> {
    const infos = names.map((name) => this.requireOpen(name));
    const ids = [...new Set(infos.map((info) => info.id))];
    const signals = [
      options.signal,
      ...(options.timeoutMs !== undefined
        ? [AbortSignal.timeout(options.timeoutMs)]
        : []),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    for (const id of ids) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    const idle = new Set<string>();
    try {
      await Promise.all(
        ids.map(async (id) => {
          const conversation = await this.harness.conversation(
            conversationId(id),
            CONTEXT,
          );
          try {
            await conversation?.waitForIdle(contextFor(signal));
            idle.add(id);
          } catch (error) {
            if (!signal?.aborted) throw error;
          }
        }),
      );
      if (options.signal?.aborted) throw new AgentError("Wait cancelled");
      await this.refresh(ids);
      for (const id of idle) await this.consume(id);
      return {
        agents: ids.map((id) => this.require(id)),
        timedOut: ids
          .filter((id) => !idle.has(id))
          .map((id) => this.require(id).name),
      };
    } finally {
      for (const id of ids) {
        const count = (this.waiters.get(id) ?? 1) - 1;
        if (count > 0) this.waiters.set(id, count);
        else this.waiters.delete(id);
      }
      this.emit();
    }
  }

  /** Settled parent requests to deliver, excluding agents under a wait. */
  pendingDeliveries(): PendingDelivery[] {
    const deliveries: PendingDelivery[] = [];
    for (const [agentId, outcomes] of this.settled) {
      if (this.isAwaited(agentId)) continue;
      const record = this.records[agentId];
      if (!record || record.closed) continue;
      const answers = new Map<number, PendingDelivery>();
      for (const [rid, outcome] of outcomes) {
        if (outcome.kind === "aborted") continue;
        if (outcome.kind === "failed") {
          deliveries.push({
            agentId,
            name: record.name,
            requestIds: [rid],
            outcome,
          });
          continue;
        }
        const existing = answers.get(outcome.result.entryId);
        if (existing) existing.requestIds.push(rid);
        else
          answers.set(outcome.result.entryId, {
            agentId,
            name: record.name,
            requestIds: [rid],
            outcome,
          });
      }
      deliveries.push(...answers.values());
    }
    return deliveries;
  }

  /** Mark settled requests delivered. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    const entryId =
      delivery.outcome.kind === "answered"
        ? delivery.outcome.result.entryId
        : undefined;
    await this.removeRequests(delivery.agentId, delivery.requestIds, entryId);
  }

  // --- Internals ---

  private generateName(profile: string | undefined): string {
    const base = profile && isValidAgentName(profile) ? profile : "agent";
    const taken = new Set(this.list().map((info) => info.name));
    if (!taken.has(base)) return base;
    for (let index = 2; ; index++) {
      const candidate = `${base}-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private resolveTools(names: string[] | undefined): ToolRegistration[] {
    const available = this.registry
      .snapshot()
      .tools()
      .filter(({ extension }) => extension.name === TOOLS_EXTENSION)
      .map(({ tool }) => tool);
    const wanted = names ?? [...DEFAULT_AGENT_TOOLS];
    const unknown = wanted.filter(
      (name) => !available.some((tool) => tool.name === name),
    );
    if (unknown.length > 0)
      throw new AgentError(
        `Unknown tools: ${unknown.join(", ")}. Available: ${available.map((tool) => tool.name).join(", ")}`,
      );
    return wanted.map(
      (name) =>
        available.find((tool) => tool.name === name) as ToolRegistration,
    );
  }

  private async submit(
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

  private async consume(agentId: string): Promise<void> {
    const outcomes = this.settled.get(agentId);
    if (!outcomes || outcomes.size === 0) return;
    const entryIds = [...outcomes.values()].flatMap((outcome) =>
      outcome.kind === "answered" ? [outcome.result.entryId] : [],
    );
    await this.removeRequests(agentId, [...outcomes.keys()], ...entryIds);
  }

  private async removeRequests(
    agentId: string,
    requestIds: string[],
    ...entryIds: Array<number | undefined>
  ): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) return;
      for (const rid of requestIds) delete record.requests[rid];
      for (const entryId of entryIds) {
        if (entryId === undefined || record.delivered.includes(entryId))
          continue;
        record.delivered.push(entryId);
      }
      if (record.delivered.length > DELIVERED_MEMORY)
        record.delivered.splice(0, record.delivered.length - DELIVERED_MEMORY);
    }, CONTEXT);
    const outcomes = this.settled.get(agentId);
    for (const rid of requestIds) outcomes?.delete(rid);
    await this.refresh([agentId]);
  }

  private async loadRecords(): Promise<Record<string, AgentRecord>> {
    const state = await this.harness.snapshot(AgentsDoc, CONTEXT);
    return structuredClone(state?.agents ?? {}) as Record<string, AgentRecord>;
  }

  private async loadLastAssistant(agentId: string): Promise<void> {
    const conversation = await this.harness.conversation(
      conversationId(agentId),
      CONTEXT,
    );
    if (!conversation) return;
    let cursor: Parameters<typeof conversation.entries>[2];
    for (let page = 0; page < 64; page++) {
      const result = await conversation.entries({}, 32, cursor, CONTEXT);
      const found = result.items.find((entry) => entry.kind === ASSISTANT_KIND);
      if (found) {
        this.lastAssistant.set(agentId, found);
        return;
      }
      if (result.next === undefined) return;
      cursor = result.next;
    }
  }

  /** Commit listener: record what changed. Must not call Session APIs. */
  private onCommit(publication: CommitPublication): void {
    const now = this.now();
    let records = false;
    for (const change of publication.changes) {
      if (change.type === "document") {
        if (change.record.kind === AgentsDoc.definition.kind) records = true;
        else if (change.conversationId !== undefined)
          this.touch(String(change.conversationId), now);
      } else if (change.type === "entry") {
        const id = String(change.value.conversationId);
        if (change.value.kind === ASSISTANT_KIND)
          this.lastAssistant.set(id, change.value);
        this.touch(id, now);
      } else if (change.type === "submission") {
        const id = String(change.value.conversationId);
        const settlement = settlementOf(change.value);
        if (settlement) this.settlements.set(id, settlement);
        this.touch(id, now);
      }
    }
    if (records) for (const id of Object.keys(this.records)) this.dirty.add(id);
    if (records || this.dirty.size > 0) this.scheduleRefresh();
  }

  private touch(agentId: string, now: number): void {
    this.dirty.add(agentId);
    this.activityAt.set(agentId, now);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const ids = [...this.dirty];
      this.dirty.clear();
      void this.refresh(ids).catch(() => {});
    }, REFRESH_DELAY_MS);
  }

  /** Recompute infos for the given agents, serialized. */
  private refresh(ids: string[]): Promise<void> {
    const run = this.refreshChain.then(async () => {
      if (this.closed) return;
      this.records = await this.loadRecords();
      const targets = new Set(ids);
      for (const id of Object.keys(this.records))
        if (!this.infos.has(id)) targets.add(id);
      const drops: Array<[string, string[]]> = [];
      for (const id of targets) {
        const record = this.records[id];
        if (!record) continue;
        drops.push([id, await this.compute(id, record)]);
      }
      this.emit();
      for (const [id, rids] of drops)
        if (rids.length > 0) await this.dropRequests(id, rids);
    });
    this.refreshChain = run.catch(() => {});
    return run;
  }

  private async dropRequests(agentId: string, rids: string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) return;
      for (const rid of rids) delete record.requests[rid];
    }, CONTEXT);
    const outcomes = this.settled.get(agentId);
    for (const rid of rids) outcomes?.delete(rid);
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
      const outcome = await this.harness.commit(async (tx) => {
        const submission = await tx.submissionByRequest(cid, rid);
        const answer =
          submission?.type === "input" && submission.status === "done"
            ? await tx.entry(submission.answer)
            : undefined;
        return outcomeOf(submission, answer, id, record.name);
      }, CONTEXT);
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

    const result: AgentResult | undefined = resultOf(
      this.lastAssistant.get(id),
      id,
      record.name,
    );
    const state = deriveState(live, result, this.settlements.get(id));
    const previous = this.infos.get(id);
    const now = this.now();
    const durable = (agent ?? {}) as DurableAgentState;
    const tools = Array.isArray(durable.tools) ? durable.tools : undefined;
    this.infos.set(id, {
      id,
      name: record.name,
      ...(record.profile ? { profile: record.profile } : {}),
      task: record.task,
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
        this.activityAt.get(id) ?? previous?.lastActivityAt ?? record.createdAt,
      usage: addPartialUsage(summarizeUsage(usage), live),
      activity: activityOf(live),
      ...(result ? { result } : {}),
      pendingRequests:
        Object.keys(record.requests).length - outcomes.size - aborted.length,
    });
    return aborted;
  }
}
