/**
 * AgentService: the agent abstraction over one pi-durable Harness.
 * Standalone agents are ownerless conversations, so aborting other work
 * never reaches them. Group agents are conversations owned by the turn
 * tasks of a group (see groups.ts). The service keeps a derived `AgentInfo`
 * per agent and a `GroupInfo` per group, refreshed from commit
 * publications, and tracks parent requests and group results until they are
 * delivered.
 */

import type {
  AttachedReplicatedState,
  Context,
  JsonValue,
} from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ConversationView,
  configure,
  createRegistry,
  type AgentState as DurableAgentState,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  LiveDoc,
  type Registry,
  type Storage,
  type TaskId,
  type TaskOutcome,
  type ToolRegistration,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { ExecutionEnvs } from "../host/env.js";
import { DEFAULT_AGENT_TOOLS, TOOLS_EXTENSION } from "../host/tools.js";
import {
  ASSISTANT_KIND,
  activityOf,
  addPartialUsage,
  deriveGroupState,
  deriveState,
  outcomeOf,
  resultOf,
  settlementOf,
  summarizeUsage,
  sumUsage,
  type TurnSettlement,
} from "./derive.js";
import {
  createGroupsExtension,
  GROUP_TASK,
  GroupTask,
  TURN_TASK,
  type TurnResult,
  TurnTask,
} from "./groups.js";
import {
  type AgentRecord,
  AgentsDoc,
  DELIVERED_MEMORY,
  type GroupRecord,
  GroupsDoc,
  type ParentRequest,
  requestId,
} from "./records.js";
import {
  type AgentDelivery,
  AgentError,
  type AgentInfo,
  type AgentResult,
  GROUP_SIZE,
  type GroupInfo,
  type GroupMember,
  type GroupPolicy,
  type GroupSpec,
  isThinkingLevel,
  type MemberOutcome,
  type PendingDelivery,
  type RequestOutcome,
  type SendMode,
  type SpawnSpec,
  type Target,
  type TaskNode,
  USER_MESSAGE_PREFIX,
} from "./types.js";

const CONTEXT = BACKGROUND_CONTEXT;
const REFRESH_DELAY_MS = 50;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
/** Longest base for generated names, leaving room for a `-<n>` suffix. */
const NAME_BASE_LENGTH = 44;

export interface AgentServiceOptions {
  storage: Storage;
  models: Models;
  /** Fallback working directory for agents without one. */
  cwd: string;
  /** Installed extensions; also the default selection of every agent. */
  extensions: Extension[];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
}

export interface WaitOutcome {
  agents: AgentInfo[];
  groups: GroupInfo[];
  /** Agents and groups still working when the wait timed out. */
  timedOut: string[];
}

function conversationId(agentId: string): ConversationId {
  return Number(agentId) as ConversationId;
}

function taskId(id: string | number): TaskId {
  return Number(id) as TaskId;
}

/** Open agents, and closed ones that work again. */
export function isVisible(info: AgentInfo): boolean {
  return !info.closed || info.state === "working";
}

/** Open groups, and closed ones still working. */
export function isGroupVisible(info: GroupInfo): boolean {
  return !info.closed || info.state === "working";
}

/** The group ended and every agent's task has an outcome. */
function isSettled(
  info: GroupInfo,
): info is GroupInfo & { members: Array<Required<GroupMember>> } {
  return (
    info.state !== "working" &&
    info.members.every((member) => member.outcome !== undefined)
  );
}

function contextFor(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, CONTEXT) : CONTEXT;
}

function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function invalidName(name: string, noun: "agent" | "group"): AgentError {
  return new AgentError(
    `Invalid ${noun} name "${name}": use letters, digits, '.', '_', or '-' (at most 48 characters)`,
  );
}

export class AgentService {
  private records: Record<string, AgentRecord> = {};
  private groupRecords: Record<string, GroupRecord> = {};
  private readonly infos = new Map<string, AgentInfo>();
  private readonly groupInfos = new Map<string, GroupInfo>();
  /** Settled outcomes of undelivered parent requests, per agent. */
  private readonly settled = new Map<string, Map<string, RequestOutcome>>();
  private readonly lastAssistant = new Map<string, EntryRecord>();
  private readonly activityAt = new Map<string, number>();
  private readonly settlements = new Map<string, TurnSettlement>();
  /** Final outcomes of group and turn tasks; they never change. */
  private readonly outcomes = new Map<number, TaskOutcome<JsonValue>>();
  /** Answer entries of group agents' turns; entries never change. */
  private readonly answers = new Map<number, EntryRecord>();
  private readonly waiters = new Map<string, number>();
  private readonly groupWaiters = new Map<string, number>();
  /** Checks run after every refresh, for waits on groups. */
  private readonly groupChecks = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private readonly dirty = new Set<string>();
  private host: Promise<Conversation> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  private constructor(
    private readonly harness: Harness,
    private readonly registry: Registry,
    private readonly envs: ExecutionEnvs,
  ) {}

  static async open(options: AgentServiceOptions): Promise<AgentService> {
    const registry = createRegistry();
    for (const extension of options.extensions) registry.install(extension);
    // Group tasks resolve from the registry; agents never select them.
    registry.install(createGroupsExtension());
    const envs = new ExecutionEnvs(options.cwd);
    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        settings: { ...options.settings, extensions: options.extensions },
        env: envs.env,
        ...(options.onReport ? { onReport: options.onReport } : {}),
      },
      CONTEXT,
    );
    const service = new AgentService(harness, registry, envs);
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
      // Outbox: a request recorded before a crash may lack its submission.
      for (const [rid, request] of Object.entries(record.requests)) {
        const existing = await this.harness.commit(
          (tx) => tx.submissionByRequest(conversationId(id), rid),
          CONTEXT,
        );
        if (!existing) await this.submit(id, rid, request);
      }
    }
    // Continue work that a previous process left unfinished, groups included.
    this.harness.resume();
    await this.refresh(Object.keys(this.records));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.listeners.clear();
    for (const check of [...this.groupChecks]) check();
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

  /**
   * Visible agents, oldest first: open ones and closed ones that work again.
   * `includeClosed` adds every closed agent.
   */
  list(options: { includeClosed?: boolean } = {}): AgentInfo[] {
    return [...this.infos.values()]
      .filter((info) => options.includeClosed || isVisible(info))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Visible groups, oldest first; `includeClosed` adds closed ones. */
  groups(options: { includeClosed?: boolean } = {}): GroupInfo[] {
    return [...this.groupInfos.values()]
      .filter((info) => options.includeClosed || isGroupVisible(info))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** A visible agent by name, else the newest closed one, else by ID. */
  get(nameOrId: string): AgentInfo | undefined {
    const named = this.list({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return named.find(isVisible) ?? named.at(-1) ?? this.infos.get(nameOrId);
  }

  /** A visible group by name, else the newest closed one, else by ID. */
  getGroup(nameOrId: string): GroupInfo | undefined {
    const named = this.groups({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return (
      named.find(isGroupVisible) ??
      named.at(-1) ??
      this.groupInfos.get(nameOrId)
    );
  }

  /**
   * An agent or a group: a visible one by name, else the newest closed one,
   * else by ID. Names are unique among visible agents and groups.
   */
  find(nameOrId: string): Target | undefined {
    const agent = this.get(nameOrId);
    const group = this.getGroup(nameOrId);
    const named = (info: { name: string } | undefined) =>
      info?.name === nameOrId;
    if (agent && named(agent) && isVisible(agent))
      return { kind: "agent", info: agent };
    if (group && named(group) && isGroupVisible(group))
      return { kind: "group", info: group };
    if (agent && group && named(agent) && named(group))
      return agent.createdAt >= group.createdAt
        ? { kind: "agent", info: agent }
        : { kind: "group", info: group };
    if (agent && named(agent)) return { kind: "agent", info: agent };
    if (group && named(group)) return { kind: "group", info: group };
    if (agent) return { kind: "agent", info: agent };
    if (group) return { kind: "group", info: group };
    return undefined;
  }

  private require(nameOrId: string): AgentInfo {
    const info = this.get(nameOrId);
    if (!info) throw new AgentError(`No agent named ${nameOrId}`);
    return info;
  }

  private requireGroup(id: string): GroupInfo {
    const info = this.groupInfos.get(id);
    if (!info) throw new AgentError(`No group with ID ${id}`);
    return info;
  }

  private requireTarget(nameOrId: string): Target {
    const target = this.find(nameOrId);
    if (!target) throw new AgentError(`No agent named ${nameOrId}`);
    return target;
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

  /** Every live task with its owner edge, for diagnostics and tests. */
  async liveTasks(): Promise<TaskNode[]> {
    const graph = await this.harness.taskGraph(CONTEXT);
    try {
      return Object.values(graph.value.tasks).map((node) => ({
        id: String(node.id),
        kind: node.kind,
        ...(node.owner === undefined ? {} : { owner: String(node.owner) }),
        background: node.background,
        status: node.state.status,
        conversations: node.conversations.map(String),
      }));
    } finally {
      graph.dispose();
    }
  }

  /** Whether a wait currently covers the agent. */
  private isAwaited(agentId: string): boolean {
    return (this.waiters.get(agentId) ?? 0) > 0;
  }

  private isGroupAwaited(groupId: string): boolean {
    return (this.groupWaiters.get(groupId) ?? 0) > 0;
  }

  /** A group agent's own results wait while its group's result is due. */
  private isHeldByGroup(record: AgentRecord): boolean {
    return (
      record.group !== undefined &&
      this.groupRecords[record.group]?.pending === true
    );
  }

  // --- Operations ---

  async spawn(spec: SpawnSpec): Promise<AgentInfo> {
    const taken = this.takenNames();
    const name = this.claimName(
      spec.name,
      spec.profile ?? "agent",
      taken,
      "agent",
    );
    const { task, tools } = this.prepare(spec);
    const first = requestId(1);
    const request: ParentRequest = { message: task, whenBusy: "followUp" };
    const createdAt = Date.now();
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

  /**
   * Start agents that work in parallel and report back as one result. One
   * commit creates the group task, a turn task per agent, and each agent's
   * conversation owned by its turn; the turns then send the tasks.
   */
  async spawnGroup(spec: GroupSpec): Promise<GroupInfo> {
    const count = spec.agents.length;
    if (count < GROUP_SIZE.min || count > GROUP_SIZE.max)
      throw new AgentError(
        `A group has ${GROUP_SIZE.min} to ${GROUP_SIZE.max} agents, not ${count}`,
      );
    const taken = this.takenNames();
    const name = this.claimName(spec.name, "group", taken, "group");
    const members = spec.agents.map((agent, index) => ({
      spec: agent,
      name: this.claimName(
        agent.name,
        agent.profile ?? `${name.slice(0, NAME_BASE_LENGTH)}-${index + 1}`,
        taken,
        "agent",
      ),
      ...this.prepare(agent),
    }));
    const policy: GroupPolicy = spec.failFast ? "failFast" : "allSettled";
    const createdAt = Date.now();
    const host = await this.hostConversation();
    const created = await host.commit(async (tx) => {
      const group = await tx.createTask(
        GroupTask,
        { policy },
        { ownership: { kind: "conversation" }, background: true },
      );
      const agents: string[] = [];
      const turns: number[] = [];
      for (const member of members) {
        const turn = await tx.createTask(
          TurnTask,
          { message: member.task },
          { ownership: { kind: "task", taskId: group } },
        );
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: turn },
        });
        const { spec: agent } = member;
        await configure(tx, conversation.id, {
          cwd: agent.cwd,
          tools: member.tools,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.thinking ? { thinkingLevel: agent.thinking } : {}),
          ...(agent.instructions ? { instructions: agent.instructions } : {}),
        });
        agents.push(String(conversation.id));
        turns.push(turn);
      }
      const state = await tx.doc(AgentsDoc);
      members.forEach((member, index) => {
        state.agents[agents[index] as string] = {
          name: member.name,
          profile: member.spec.profile ?? null,
          task: member.task,
          createdAt,
          closed: false,
          ambientSkills: member.spec.ambientSkills ?? true,
          // The turn sends the task; parent requests are later messages.
          nextRequest: 1,
          requests: {},
          delivered: [],
          group: String(group),
        };
      });
      (await tx.doc(GroupsDoc)).groups[String(group)] = {
        name,
        policy,
        createdAt,
        agents,
        turns,
        closed: false,
        pending: true,
      };
      return { id: String(group), agents };
    }, CONTEXT);
    await this.refresh(created.agents);
    return this.requireGroup(created.id);
  }

  /** Message an agent on behalf of the parent model. */
  async send(nameOrId: string, message: string, mode: SendMode): Promise<void> {
    const target = this.requireTarget(nameOrId);
    if (target.kind === "group")
      throw new AgentError(
        `${target.info.name} is a group. Message its agents instead: ${target.info.members.map((member) => member.name).join(", ")}`,
      );
    const info = target.info;
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
      record.closed = false;
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
    const info = this.require(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    if (!conversation) throw new AgentError(`Agent ${info.name} is missing`);
    await conversation.submit(
      {
        type: "input",
        content: `${USER_MESSAGE_PREFIX}${text}`,
        whenBusy: mode === "followUp" ? "followUp" : "steer",
      },
      CONTEXT,
    );
  }

  /** Abort the agent's current work and withdraw its queued messages. */
  async interrupt(nameOrId: string): Promise<void> {
    const info = this.require(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    await conversation?.abort(CONTEXT);
    await this.refresh([info.id]);
  }

  /**
   * End an agent or a group. An agent's work is interrupted, its pending
   * parent requests dropped, and it closes; storage keeps its conversation,
   * and messaging it later reopens it. A group is aborted with its agents,
   * delivers nothing, and closes with them.
   */
  async stop(nameOrId: string): Promise<Target> {
    const target = this.requireTarget(nameOrId);
    if (target.kind === "group") {
      await this.stopGroup(target.info.id);
      return { kind: "group", info: this.requireGroup(target.info.id) };
    }
    await this.stopAgent(target.info.id);
    return { kind: "agent", info: this.require(target.info.id) };
  }

  private async stopAgent(agentId: string): Promise<void> {
    await this.interrupt(agentId);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const record = state.agents[agentId];
      if (!record) return;
      record.closed = true;
      record.requests = {};
    }, CONTEXT);
    this.settled.delete(agentId);
    await this.refresh([agentId]);
  }

  private async stopGroup(groupId: string): Promise<void> {
    const info = this.requireGroup(groupId);
    await this.harness.commit(async (tx) => {
      const group = (await tx.doc(GroupsDoc)).groups[groupId];
      if (!group) return;
      group.pending = false;
      group.closed = true;
    }, CONTEXT);
    // Aborting the group aborts its turns, and they their agents, bottom-up.
    if ((await this.taskOutcome(Number(groupId))) === undefined) {
      await this.harness.abortTask(taskId(groupId), CONTEXT);
      await this.harness.waitForTask(taskId(groupId), CONTEXT);
    }
    // Agents may work beyond their turn, for example on a user's message.
    for (const member of info.members) await this.stopAgent(member.agentId);
    await this.refresh([]);
  }

  /**
   * Wait until the agents are idle and the groups finished, and return
   * them. Their results count as delivered. Aborting `signal` ends only the
   * wait.
   */
  async wait(
    names: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<WaitOutcome> {
    const targets = names.map((name) => this.requireTarget(name));
    const ids = [
      ...new Set(
        targets.flatMap((target) =>
          target.kind === "agent" ? [target.info.id] : [],
        ),
      ),
    ];
    const groupIds = [
      ...new Set(
        targets.flatMap((target) =>
          target.kind === "group" ? [target.info.id] : [],
        ),
      ),
    ];
    const signals = [
      options.signal,
      ...(options.timeoutMs !== undefined
        ? [AbortSignal.timeout(options.timeoutMs)]
        : []),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    for (const id of ids) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    for (const id of groupIds)
      this.groupWaiters.set(id, (this.groupWaiters.get(id) ?? 0) + 1);
    const idle = new Set<string>();
    const ended = new Set<string>();
    try {
      await Promise.all([
        ...ids.map(async (id) => {
          // A group agent's task arrives through its turn.
          if (!(await this.untilTurnEnded(id, signal))) return;
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
        ...groupIds.map(async (id) => {
          if (await this.untilSettled(id, signal)) ended.add(id);
        }),
      ]);
      if (options.signal?.aborted) throw new AgentError("Wait cancelled");
      await this.refresh(ids);
      for (const id of idle) await this.consume(id);
      for (const id of ended)
        if (this.groupRecords[id]?.pending) await this.consumeGroup(id);
      return {
        agents: ids.map((id) => this.require(id)),
        groups: groupIds.map((id) => this.requireGroup(id)),
        timedOut: [
          ...ids.filter((id) => !idle.has(id)).map((id) => this.require(id)),
          ...groupIds
            .filter((id) => !ended.has(id))
            .map((id) => this.requireGroup(id)),
        ].map((info) => info.name),
      };
    } finally {
      for (const [counts, keys] of [
        [this.waiters, ids],
        [this.groupWaiters, groupIds],
      ] as const)
        for (const id of keys) {
          const count = (counts.get(id) ?? 1) - 1;
          if (count > 0) counts.set(id, count);
          else counts.delete(id);
        }
      this.emit();
    }
  }

  /** Resolve true once the group settled, false when `signal` aborts first. */
  private untilSettled(
    groupId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const info = this.groupInfos.get(groupId);
      return info !== undefined && isSettled(info);
    }, signal);
  }

  /** Resolve true once a group agent's turn ended, or at once for others. */
  private untilTurnEnded(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const group = this.infos.get(agentId)?.group;
      if (group === undefined) return true;
      const member = this.groupInfos
        .get(group)
        ?.members.find((each) => each.agentId === agentId);
      return member === undefined || member.outcome !== undefined;
    }, signal);
  }

  /** Resolve true once `ready` holds after a refresh, false on abort or close. */
  private until(ready: () => boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        this.groupChecks.delete(check);
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const check = () => {
        if (ready()) done(true);
        else if (this.closed) done(false);
      };
      const aborted = () => done(false);
      this.groupChecks.add(check);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) done(false);
      else check();
    });
  }

  /**
   * Results to deliver: finished groups the parent still expects, and
   * settled parent requests. Agents and groups under a wait are excluded, and
   * so are agents whose group's result is still due.
   */
  pendingDeliveries(): PendingDelivery[] {
    const deliveries: PendingDelivery[] = [];
    for (const [groupId, record] of Object.entries(this.groupRecords)) {
      if (!record.pending || this.isGroupAwaited(groupId)) continue;
      const info = this.groupInfos.get(groupId);
      if (!info || !isSettled(info) || info.stopped) continue;
      deliveries.push({
        kind: "group",
        groupId,
        name: info.name,
        members: info.members,
      });
    }
    for (const [agentId, outcomes] of this.settled) {
      if (this.isAwaited(agentId)) continue;
      const record = this.records[agentId];
      if (!record || this.isHeldByGroup(record)) continue;
      const answers = new Map<number, AgentDelivery>();
      for (const [rid, outcome] of outcomes) {
        if (outcome.kind === "aborted") continue;
        if (outcome.kind === "failed") {
          deliveries.push({
            kind: "agent",
            agentId,
            name: record.name,
            requestIds: [rid],
            outcome,
          });
          continue;
        }
        if (record.delivered.includes(outcome.result.entryId)) continue;
        const existing = answers.get(outcome.result.entryId);
        if (existing) existing.requestIds.push(rid);
        else
          answers.set(outcome.result.entryId, {
            kind: "agent",
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

  /** Mark a delivery done. An answered agent closes, and so does a group. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    if (delivery.kind === "group") {
      await this.consumeGroup(delivery.groupId);
      return;
    }
    const entryId =
      delivery.outcome.kind === "answered"
        ? delivery.outcome.result.entryId
        : undefined;
    await this.removeRequests(
      delivery.agentId,
      delivery.requestIds,
      entryId === undefined ? [] : [entryId],
    );
  }

  // --- Internals ---

  /** Names of visible agents and groups. */
  private takenNames(): Set<string> {
    return new Set([
      ...this.list().map((info) => info.name),
      ...this.groups().map((info) => info.name),
    ]);
  }

  /** Validate and reserve a requested name, or generate one from `base`. */
  private claimName(
    requested: string | undefined,
    base: string,
    taken: Set<string>,
    noun: "agent" | "group",
  ): string {
    const wanted = requested?.trim();
    let name: string;
    if (wanted) {
      if (!isValidAgentName(wanted)) throw invalidName(wanted, noun);
      if (taken.has(wanted))
        throw new AgentError(
          `An ${noun === "agent" ? "agent" : "agent or group"} named ${wanted} already exists`,
        );
      name = wanted;
    } else {
      const stem = isValidAgentName(base)
        ? base.slice(0, NAME_BASE_LENGTH)
        : noun;
      name = stem;
      for (let index = 2; taken.has(name); index++) name = `${stem}-${index}`;
    }
    taken.add(name);
    return name;
  }

  /** Validate a spawn's task, thinking level, and tools. */
  private prepare(spec: SpawnSpec): {
    task: string;
    tools: ToolRegistration[];
  } {
    if (spec.thinking !== undefined && !isThinkingLevel(spec.thinking))
      throw new AgentError(`Invalid thinking level: ${spec.thinking}`);
    const tools = this.resolveTools(spec.tools);
    const task = spec.task.trim();
    if (!task) throw new AgentError("The task must not be empty");
    return { task, tools };
  }

  /** The conversation that owns group tasks; it never runs itself. */
  private hostConversation(): Promise<Conversation> {
    this.host ??= this.harness.root(CONTEXT);
    return this.host;
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
    await this.removeRequests(agentId, [...outcomes.keys()], entryIds);
  }

  /**
   * A group's result reached the parent: the group closes, and so do its
   * agents that answered or that the group stopped. Their answers count as
   * delivered, so parent messages answered by the same entry deliver with
   * the group. Failed and interrupted agents stay open.
   */
  private async consumeGroup(groupId: string): Promise<void> {
    const info = this.requireGroup(groupId);
    await this.harness.commit(async (tx) => {
      const group = (await tx.doc(GroupsDoc)).groups[groupId];
      if (!group) return;
      group.pending = false;
      group.closed = true;
      const state = await tx.doc(AgentsDoc);
      for (const member of info.members) {
        const record = state.agents[member.agentId];
        const outcome = member.outcome;
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
          for (const [rid, settled] of this.settled.get(member.agentId) ?? [])
            if (
              settled.kind === "answered" &&
              settled.result.entryId === entryId
            )
              delete record.requests[rid];
        }
        if (
          (outcome.kind === "answered" || outcome.kind === "stopped") &&
          Object.keys(record.requests).length === 0
        )
          record.closed = true;
      }
    }, CONTEXT);
    await this.refresh(info.members.map((member) => member.agentId));
  }

  /**
   * Drop delivered requests. Delivering an answer closes the agent once no
   * parent request remains: it is done. Messaging it later reopens it.
   */
  private async removeRequests(
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
    const outcomes = this.settled.get(agentId);
    for (const rid of requestIds) outcomes?.delete(rid);
    await this.refresh([agentId]);
  }

  private async loadRecords(): Promise<Record<string, AgentRecord>> {
    const state = await this.harness.snapshot(AgentsDoc, CONTEXT);
    return structuredClone(state?.agents ?? {}) as Record<string, AgentRecord>;
  }

  private async loadGroups(): Promise<Record<string, GroupRecord>> {
    const state = await this.harness.snapshot(GroupsDoc, CONTEXT);
    return structuredClone(state?.groups ?? {}) as Record<string, GroupRecord>;
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
    const now = Date.now();
    let records = false;
    let groups = false;
    for (const change of publication.changes) {
      if (change.type === "document") {
        if (change.record.kind === AgentsDoc.definition.kind) records = true;
        else if (change.record.kind === GroupsDoc.definition.kind)
          groups = true;
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
      } else if (change.type === "task") {
        if (change.value.kind === GROUP_TASK) groups = true;
        else if (change.value.kind === TURN_TASK) {
          groups = true;
          // A turn's end ends its agent's work.
          const agentId = this.agentOfTurn(Number(change.value.id));
          if (agentId !== undefined) this.dirty.add(agentId);
        }
      }
    }
    if (records) for (const id of Object.keys(this.records)) this.dirty.add(id);
    if (records || groups || this.dirty.size > 0) this.scheduleRefresh();
  }

  private agentOfTurn(turn: number): string | undefined {
    for (const group of Object.values(this.groupRecords)) {
      const index = group.turns.indexOf(turn);
      if (index >= 0) return group.agents[index];
    }
    return undefined;
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

  /** Recompute infos for the given agents and every group, serialized. */
  private refresh(ids: string[]): Promise<void> {
    const run = this.refreshChain.then(async () => {
      if (this.closed) return;
      this.records = await this.loadRecords();
      this.groupRecords = await this.loadGroups();
      const targets = new Set(ids);
      for (const id of Object.keys(this.records))
        if (!this.infos.has(id)) targets.add(id);
      const drops: Array<[string, string[]]> = [];
      for (const id of targets) {
        const record = this.records[id];
        if (!record) continue;
        drops.push([id, await this.compute(id, record)]);
      }
      const stopped = await this.computeGroups();
      this.emit();
      for (const [id, rids] of drops)
        if (rids.length > 0) await this.dropRequests(id, rids);
      if (stopped.length > 0) await this.clearPending(stopped);
      for (const check of [...this.groupChecks]) check();
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

  /** A stopped group delivers nothing. */
  private async clearPending(groupIds: string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(GroupsDoc);
      for (const id of groupIds) {
        const group = state.groups[id];
        if (group) group.pending = false;
      }
    }, CONTEXT);
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
    // A group agent works from its spawn until its turn ended, also before
    // the turn submitted the task.
    const state =
      live?.run === undefined && (await this.isTurnLive(id, record))
        ? "working"
        : deriveState(live, result, this.settlements.get(id));
    const previous = this.infos.get(id);
    const now = Date.now();
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
      ...(record.group ? { group: record.group } : {}),
    });
    return aborted;
  }

  /** Whether the agent belongs to a group whose turn for it still runs. */
  private async isTurnLive(
    agentId: string,
    record: AgentRecord,
  ): Promise<boolean> {
    const group =
      record.group === undefined ? undefined : this.groupRecords[record.group];
    const turn = group?.turns[group.agents.indexOf(agentId)];
    return turn !== undefined && (await this.taskOutcome(turn)) === undefined;
  }

  /** The final outcome of a task once decided, read once and cached. */
  private async taskOutcome(
    id: number,
  ): Promise<TaskOutcome<JsonValue> | undefined> {
    const cached = this.outcomes.get(id);
    if (cached) return cached;
    const record = await this.harness.getTask(taskId(id), CONTEXT);
    if (!record)
      return { status: "faulted", error: { message: "task missing" } };
    const state = record.state;
    if (state.status !== "completing" && state.status !== "terminal")
      return undefined;
    const outcome = state.outcome as TaskOutcome<JsonValue>;
    this.outcomes.set(id, outcome);
    return outcome;
  }

  private async answer(entryId: number): Promise<EntryRecord | undefined> {
    const cached = this.answers.get(entryId);
    if (cached) return cached;
    const entry = await this.harness.commit(
      (tx) => tx.entry(entryId as EntryRecord["id"]),
      CONTEXT,
    );
    if (entry) this.answers.set(entryId, entry);
    return entry;
  }

  /** How a group agent's turn ended, once it did. */
  private async memberOutcome(
    turn: number,
    agentId: string,
    name: string,
  ): Promise<MemberOutcome | undefined> {
    const outcome = await this.taskOutcome(turn);
    if (!outcome) return undefined;
    switch (outcome.status) {
      case "completed": {
        const result = outcome.result as TurnResult;
        if (result.kind !== "answered") return { kind: "interrupted" };
        const answered = resultOf(
          await this.answer(result.entryId),
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

  /** Recompute every group's info; returns stopped groups still pending. */
  private async computeGroups(): Promise<string[]> {
    const stopped: string[] = [];
    const now = Date.now();
    for (const [id, record] of Object.entries(this.groupRecords)) {
      const ended = await this.taskOutcome(Number(id));
      const members: GroupMember[] = [];
      for (const [index, agentId] of record.agents.entries()) {
        const name = this.records[agentId]?.name ?? agentId;
        const turn = record.turns[index];
        const outcome =
          turn === undefined
            ? undefined
            : await this.memberOutcome(turn, agentId, name);
        members.push({ agentId, name, ...(outcome ? { outcome } : {}) });
      }
      const state = deriveGroupState(ended, members);
      const isStopped = ended?.status === "aborted";
      if (isStopped && record.pending) stopped.push(id);
      const previous = this.groupInfos.get(id);
      this.groupInfos.set(id, {
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
        members,
        usage: sumUsage(
          record.agents.flatMap((agentId) => {
            const usage = this.infos.get(agentId)?.usage;
            return usage ? [usage] : [];
          }),
        ),
      });
    }
    return stopped;
  }
}
