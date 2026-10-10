/**
 * AgentService: the agent abstraction over one pi-durable Harness.
 * Standalone agents are ownerless conversations, so aborting other work
 * never reaches them. A graph's agents are conversations owned by the node
 * tasks of the graph (see graphs.ts). The service keeps a derived
 * `AgentInfo` per agent and a `GraphInfo` per graph, refreshed from commit
 * publications, and tracks parent requests and graph results until they are
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
  createDelegationExtension,
  DELEGATE_TOOL,
  DELEGATION_LIMITS,
  type DelegationLimits,
} from "./delegation.js";
import {
  ASSISTANT_KIND,
  activityOf,
  addPartialUsage,
  deriveGraphState,
  deriveState,
  type EndedTurn,
  endedTurnOf,
  GENERATION_KIND,
  outcomeOf,
  resultOf,
  settlementOf,
  summarizeUsage,
  sumUsage,
  type TurnSettlement,
} from "./derive.js";
import {
  createGraphsExtension,
  GRAPH_TASK,
  GraphTask,
  NODE_TASK,
  type NodeResult,
  NodeTask,
  nodeRequestId,
} from "./graphs.js";
import { claimName, NAME_BASE_LENGTH, takenNames } from "./names.js";
import {
  type AgentRecord,
  AgentsDoc,
  DELIVERED_MEMORY,
  type GraphNodeRecord,
  type GraphRecord,
  GraphsDoc,
  type ParentRequest,
  requestId,
} from "./records.js";
import { endNodes, resolveEdges, stages } from "./topology.js";
import {
  type AgentDelivery,
  AgentError,
  type AgentInfo,
  type AgentResult,
  GRAPH_SIZE,
  type GraphInfo,
  type GraphNode,
  type GraphPolicy,
  type GraphSpec,
  type HelperResolver,
  isThinkingLevel,
  type NodeOutcome,
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

export interface AgentServiceOptions {
  storage: Storage;
  models: Models;
  /** Fallback working directory for agents without one. */
  cwd: string;
  /** Installed extensions; also the default selection of every agent. */
  extensions: Extension[];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
  /** Resolves the profiles, models, and skills of helpers. */
  resolveHelper: HelperResolver;
  /** Tests only: tighter delegation limits. */
  delegationLimits?: Partial<DelegationLimits>;
}

export interface WaitOutcome {
  agents: AgentInfo[];
  graphs: GraphInfo[];
  /** Agents and graphs still working when the wait timed out. */
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

/** Open graphs, and closed ones still working. */
export function isGraphVisible(info: GraphInfo): boolean {
  return !info.closed || info.state === "working";
}

/** The graph ended and every agent's task has an outcome. */
function isSettled(
  info: GraphInfo,
): info is GraphInfo & { nodes: Array<GraphNode & { outcome: NodeOutcome }> } {
  return (
    info.state !== "working" &&
    info.nodes.every((node) => node.outcome !== undefined)
  );
}

function contextFor(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, CONTEXT) : CONTEXT;
}

export class AgentService {
  private records: Record<string, AgentRecord> = {};
  private graphRecords: Record<string, GraphRecord> = {};
  private readonly infos = new Map<string, AgentInfo>();
  private readonly graphInfos = new Map<string, GraphInfo>();
  /** Settled outcomes of undelivered parent requests, per agent. */
  private readonly settled = new Map<string, Map<string, RequestOutcome>>();
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
  /** Answer entries of graph agents' tasks; entries never change. */
  private readonly answers = new Map<number, EntryRecord>();
  /** Per agent, the entry that answered its task, or null when the task
   * ended without an answer; settled submissions never change. */
  private readonly taskAnswers = new Map<string, number | null>();
  private readonly waiters = new Map<string, number>();
  private readonly graphWaiters = new Map<string, number>();
  /** Checks run after every refresh, for waits on graphs and nodes. */
  private readonly checks = new Set<() => void>();
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
    private readonly delegation: Extension,
  ) {}

  static async open(options: AgentServiceOptions): Promise<AgentService> {
    const registry = createRegistry();
    for (const extension of options.extensions) registry.install(extension);
    // Graph tasks resolve from the registry; agents never select them.
    registry.install(createGraphsExtension());
    // Only delegating agents select delegation; see `delegatingAgent`.
    const delegation = createDelegationExtension({
      resolve: options.resolveHelper,
      limits: { ...DELEGATION_LIMITS, ...options.delegationLimits },
    });
    registry.install(delegation);
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
    const service = new AgentService(harness, registry, envs, delegation);
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
    // Continue work that a previous process left unfinished, graphs included.
    this.harness.resume();
    await this.refresh(Object.keys(this.records));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.listeners.clear();
    for (const check of [...this.checks]) check();
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

  /** Visible graphs, oldest first; `includeClosed` adds closed ones. */
  graphs(options: { includeClosed?: boolean } = {}): GraphInfo[] {
    return [...this.graphInfos.values()]
      .filter((info) => options.includeClosed || isGraphVisible(info))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** A visible agent by name, else the newest closed one, else by ID. */
  get(nameOrId: string): AgentInfo | undefined {
    const named = this.list({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return named.find(isVisible) ?? named.at(-1) ?? this.infos.get(nameOrId);
  }

  /** A visible graph by name, else the newest closed one, else by ID. */
  getGraph(nameOrId: string): GraphInfo | undefined {
    const named = this.graphs({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return (
      named.find(isGraphVisible) ??
      named.at(-1) ??
      this.graphInfos.get(nameOrId)
    );
  }

  /**
   * An agent or a graph: a visible one by name, else the newest closed one,
   * else by ID. Names are unique among visible agents and graphs.
   */
  find(nameOrId: string): Target | undefined {
    const agent = this.get(nameOrId);
    const graph = this.getGraph(nameOrId);
    const named = (info: { name: string } | undefined) =>
      info?.name === nameOrId;
    if (agent && named(agent) && isVisible(agent))
      return { kind: "agent", info: agent };
    if (graph && named(graph) && isGraphVisible(graph))
      return { kind: "graph", info: graph };
    if (agent && graph && named(agent) && named(graph))
      return agent.createdAt >= graph.createdAt
        ? { kind: "agent", info: agent }
        : { kind: "graph", info: graph };
    if (agent && named(agent)) return { kind: "agent", info: agent };
    if (graph && named(graph)) return { kind: "graph", info: graph };
    if (agent) return { kind: "agent", info: agent };
    if (graph) return { kind: "graph", info: graph };
    return undefined;
  }

  private require(nameOrId: string): AgentInfo {
    const info = this.get(nameOrId);
    if (!info) throw new AgentError(`No agent named ${nameOrId}`);
    return info;
  }

  private requireGraph(id: string): GraphInfo {
    const info = this.graphInfos.get(id);
    if (!info) throw new AgentError(`No graph with ID ${id}`);
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

  private isGraphAwaited(graphId: string): boolean {
    return (this.graphWaiters.get(graphId) ?? 0) > 0;
  }

  /** A graph agent's own results wait while its graph's result is due. */
  private isHeldByGraph(record: AgentRecord): boolean {
    return (
      record.graph !== undefined &&
      this.graphRecords[record.graph]?.pending === true
    );
  }

  // --- Operations ---

  async spawn(spec: SpawnSpec): Promise<AgentInfo> {
    // Fail early with the service's view; the commit claims for real.
    claimName(spec.name, spec.profile ?? "agent", this.takenNames(), "agent");
    const { task, tools } = this.prepare(spec);
    const first = requestId(1);
    const request: ParentRequest = { message: task, whenBusy: "followUp" };
    const createdAt = Date.now();
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          cwd: spec.cwd,
          ...this.capabilities(tools, spec.delegate),
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        },
        init: async (tx, id) => {
          const state = await tx.doc(AgentsDoc);
          const name = claimName(
            spec.name,
            spec.profile ?? "agent",
            takenNames(state, await tx.doc(GraphsDoc), this.workingClosed()),
            "agent",
          );
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
            ...(spec.delegate ? { delegate: true } : {}),
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
   * Start agents that work together and report back as one result. An agent
   * that lists others in `after` starts once they ended and receives their
   * results. One commit creates the graph task, a node task per agent, and
   * each agent's conversation owned by its node; the nodes then send the
   * tasks.
   */
  async spawnGraph(spec: GraphSpec): Promise<GraphInfo> {
    const count = spec.agents.length;
    if (count < GRAPH_SIZE.min || count > GRAPH_SIZE.max)
      throw new AgentError(
        `A graph has ${GRAPH_SIZE.min} to ${GRAPH_SIZE.max} agents, not ${count}`,
      );
    // Validate with the service's view first; the commit claims for real.
    const claim = (taken: Set<string>) => {
      const graph = claimName(spec.name, "graph", taken, "graph");
      return {
        graph,
        agents: spec.agents.map((agent, index) =>
          claimName(
            agent.name,
            agent.profile ?? `${graph.slice(0, NAME_BASE_LENGTH)}-${index + 1}`,
            taken,
            "agent",
          ),
        ),
      };
    };
    const planned = claim(this.takenNames());
    const nodes = spec.agents.map((agent, index) => ({
      spec: agent,
      name: planned.agents[index] as string,
      ...this.prepare(agent),
    }));
    const inputs = resolveEdges(
      nodes.map((node) => ({ name: node.name, after: node.spec.after })),
    );
    const policy: GraphPolicy = spec.failFast ? "failFast" : "allSettled";
    const createdAt = Date.now();
    const host = await this.hostConversation();
    const created = await host.commit(async (tx) => {
      const names = claim(
        takenNames(
          await tx.doc(AgentsDoc),
          await tx.doc(GraphsDoc),
          this.workingClosed(),
        ),
      );
      const graph = await tx.createTask(
        GraphTask,
        { policy },
        { ownership: { kind: "conversation" }, background: true },
      );
      const agents: string[] = [];
      const tasks: number[] = [];
      for (const node of nodes) {
        const task = await tx.createTask(
          NodeTask,
          { message: node.task },
          { ownership: { kind: "task", taskId: graph } },
        );
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        const { spec: agent } = node;
        await configure(tx, conversation.id, {
          cwd: agent.cwd,
          ...this.capabilities(node.tools, agent.delegate),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.thinking ? { thinkingLevel: agent.thinking } : {}),
          ...(agent.instructions ? { instructions: agent.instructions } : {}),
        });
        agents.push(String(conversation.id));
        tasks.push(task);
      }
      const state = await tx.doc(AgentsDoc);
      nodes.forEach((node, index) => {
        state.agents[agents[index] as string] = {
          name: names.agents[index] as string,
          profile: node.spec.profile ?? null,
          task: node.task,
          createdAt,
          closed: false,
          ambientSkills: node.spec.ambientSkills ?? true,
          // The node sends the task; parent requests are later messages.
          nextRequest: 1,
          requests: {},
          delivered: [],
          graph: String(graph),
          ...(node.spec.delegate ? { delegate: true } : {}),
        };
      });
      (await tx.doc(GraphsDoc)).graphs[String(graph)] = {
        name: names.graph,
        policy,
        createdAt,
        nodes: nodes.map((_node, index) => ({
          agent: agents[index] as string,
          task: tasks[index] as number,
          after: (inputs[index] ?? []).map((input) => agents[input] as string),
        })),
        closed: false,
        pending: true,
      };
      return { id: String(graph), agents };
    }, CONTEXT);
    await this.refresh(created.agents);
    return this.requireGraph(created.id);
  }

  /** Message an agent on behalf of the parent model. */
  async send(nameOrId: string, message: string, mode: SendMode): Promise<void> {
    const target = this.requireTarget(nameOrId);
    if (target.kind === "graph")
      throw new AgentError(
        `${target.info.name} is a graph. Message its agents instead: ${target.info.nodes.map((node) => node.name).join(", ")}`,
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
    await this.refresh(this.withHelpers([info.id]));
  }

  /** The agents and the helpers they started. */
  private withHelpers(ids: string[]): string[] {
    const all = new Set(ids);
    for (const graph of Object.values(this.graphRecords))
      if (graph.owner && all.has(graph.owner.agent))
        for (const node of graph.nodes) all.add(node.agent);
    return [...all];
  }

  /**
   * End an agent or a graph. An agent's work is interrupted, its pending
   * parent requests dropped, and it closes; storage keeps its conversation,
   * and messaging it later reopens it. A graph is aborted with its agents,
   * delivers nothing, and closes with them.
   */
  async stop(nameOrId: string): Promise<Target> {
    const target = this.requireTarget(nameOrId);
    if (target.kind === "graph") {
      await this.stopGraph(target.info.id);
      return { kind: "graph", info: this.requireGraph(target.info.id) };
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

  private async stopGraph(graphId: string): Promise<void> {
    const info = this.requireGraph(graphId);
    const finished = await this.isFinished(Number(graphId));
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (!graph) return;
      graph.pending = false;
      graph.closed = true;
      // A graph that holds a decided outcome can't become aborted, so the
      // record keeps the stop.
      if (!finished) graph.stopped = true;
    }, CONTEXT);
    // Aborting the graph aborts its nodes, and they their agents, bottom-up.
    // A held graph only marks the work below it.
    if (!finished) {
      await this.harness.abortTask(taskId(graphId), CONTEXT);
      await this.harness.waitForTask(taskId(graphId), CONTEXT);
    }
    // Agents may work beyond their task, for example on a user's message.
    for (const node of info.nodes) await this.stopAgent(node.agentId);
    await this.refresh(
      this.withHelpers(info.nodes.map((node) => node.agentId)),
    );
  }

  /**
   * Wait until the agents are idle and the graphs finished, and return
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
    const graphIds = [
      ...new Set(
        targets.flatMap((target) =>
          target.kind === "graph" ? [target.info.id] : [],
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
    for (const id of graphIds)
      this.graphWaiters.set(id, (this.graphWaiters.get(id) ?? 0) + 1);
    const idle = new Set<string>();
    const ended = new Set<string>();
    try {
      await Promise.all([
        ...ids.map(async (id) => {
          // A graph agent's task arrives through its node.
          if (!(await this.untilNodeEnded(id, signal))) return;
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
        ...graphIds.map(async (id) => {
          if (await this.untilSettled(id, signal)) ended.add(id);
        }),
      ]);
      if (options.signal?.aborted) throw new AgentError("Wait cancelled");
      await this.refresh(ids);
      for (const id of idle) await this.consume(id);
      for (const id of ended)
        if (this.graphRecords[id]?.pending) await this.consumeGraph(id);
      return {
        agents: ids.map((id) => this.require(id)),
        graphs: graphIds.map((id) => this.requireGraph(id)),
        timedOut: [
          ...ids.filter((id) => !idle.has(id)).map((id) => this.require(id)),
          ...graphIds
            .filter((id) => !ended.has(id))
            .map((id) => this.requireGraph(id)),
        ].map((info) => info.name),
      };
    } finally {
      for (const [counts, keys] of [
        [this.waiters, ids],
        [this.graphWaiters, graphIds],
      ] as const)
        for (const id of keys) {
          const count = (counts.get(id) ?? 1) - 1;
          if (count > 0) counts.set(id, count);
          else counts.delete(id);
        }
      this.emit();
    }
  }

  /** Resolve true once the graph settled, false when `signal` aborts first. */
  private untilSettled(
    graphId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const info = this.graphInfos.get(graphId);
      return info !== undefined && isSettled(info);
    }, signal);
  }

  /** Resolve true once a graph agent's node ended, or at once for others. */
  private untilNodeEnded(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const graph = this.infos.get(agentId)?.graph;
      if (graph === undefined) return true;
      const node = this.graphInfos
        .get(graph)
        ?.nodes.find((each) => each.agentId === agentId);
      return node === undefined || node.outcome !== undefined;
    }, signal);
  }

  /** Resolve true once `ready` holds after a refresh, false on abort or close. */
  private until(ready: () => boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        this.checks.delete(check);
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const check = () => {
        if (ready()) done(true);
        else if (this.closed) done(false);
      };
      const aborted = () => done(false);
      this.checks.add(check);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) done(false);
      else check();
    });
  }

  /**
   * Results to deliver: finished graphs the parent still expects, and
   * settled parent requests. Agents and graphs under a wait are excluded, and
   * so are agents whose graph's result is still due.
   */
  pendingDeliveries(): PendingDelivery[] {
    const deliveries: PendingDelivery[] = [];
    for (const [graphId, record] of Object.entries(this.graphRecords)) {
      if (!record.pending || this.isGraphAwaited(graphId)) continue;
      const info = this.graphInfos.get(graphId);
      if (!info || !isSettled(info) || info.stopped) continue;
      deliveries.push({
        kind: "graph",
        graphId,
        name: info.name,
        nodes: info.nodes,
      });
    }
    for (const [agentId, outcomes] of this.settled) {
      if (this.isAwaited(agentId)) continue;
      const record = this.records[agentId];
      if (!record || this.isHeldByGraph(record)) continue;
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

  /** Mark a delivery done. An answered agent closes, and so does a graph. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    if (delivery.kind === "graph") {
      await this.consumeGraph(delivery.graphId);
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

  /** Names of visible agents and graphs, as the service last saw them. */
  private takenNames(): Set<string> {
    return new Set([
      ...this.list().map((info) => info.name),
      ...this.graphs().map((info) => info.name),
    ]);
  }

  /** Closed agents that work again: visible, so their names stay taken. */
  private workingClosed(): string[] {
    return this.list()
      .filter((info) => info.closed)
      .map((info) => info.name);
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

  /** The conversation that owns graph tasks; it never runs itself. */
  private hostConversation(): Promise<Conversation> {
    this.host ??= this.harness.root(CONTEXT);
    return this.host;
  }

  /**
   * The tools and extensions of a new agent. A delegating agent also selects
   * the delegation extension and its tool, so only it can start helpers.
   */
  private capabilities(
    tools: ToolRegistration[],
    delegate: boolean | undefined,
  ): { tools: ToolRegistration[]; extensions?: { add: Extension[] } } {
    if (!delegate) return { tools };
    const tool = this.delegation.tools?.find(
      (each) => each.name === DELEGATE_TOOL,
    );
    return {
      tools: tool ? [...tools, tool] : tools,
      extensions: { add: [this.delegation] },
    };
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
   * A graph's result reached the parent: the graph closes, and so do its
   * agents that answered, never started, or that the graph stopped. Their
   * answers count as delivered, so parent messages answered by the same
   * entry deliver with the graph. Failed and interrupted agents stay open.
   */
  private async consumeGraph(graphId: string): Promise<void> {
    const info = this.requireGraph(graphId);
    await this.harness.commit(async (tx) => {
      const graph = (await tx.doc(GraphsDoc)).graphs[graphId];
      if (!graph) return;
      graph.pending = false;
      graph.closed = true;
      const state = await tx.doc(AgentsDoc);
      for (const node of info.nodes) {
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
          for (const [rid, settled] of this.settled.get(node.agentId) ?? [])
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
    await this.refresh(info.nodes.map((node) => node.agentId));
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

  private async loadGraphs(): Promise<Record<string, GraphRecord>> {
    const state = await this.harness.snapshot(GraphsDoc, CONTEXT);
    return structuredClone(state?.graphs ?? {}) as Record<string, GraphRecord>;
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
    let graphs = false;
    // Turns this commit ended, which may settle several inputs of one run.
    const ended = new Map<string, EndedTurn>();
    for (const change of publication.changes) {
      if (change.type === "document") {
        if (change.record.kind === AgentsDoc.definition.kind) records = true;
        else if (change.record.kind === GraphsDoc.definition.kind)
          graphs = true;
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
          const graph = this.graphOfNode(Number(change.value.id));
          for (const node of graph?.nodes ?? []) this.dirty.add(node.agent);
        }
      }
    }
    for (const [id, turn] of ended) this.endedTurns.set(id, turn);
    if (records) for (const id of Object.keys(this.records)) this.dirty.add(id);
    if (records || graphs || this.dirty.size > 0) this.scheduleRefresh();
  }

  private graphOfNode(task: number): GraphRecord | undefined {
    return Object.values(this.graphRecords).find((graph) =>
      graph.nodes.some((node) => node.task === task),
    );
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

  /** Recompute infos for the given agents and every graph, serialized. */
  private refresh(ids: string[]): Promise<void> {
    const run = this.refreshChain.then(async () => {
      if (this.closed) return;
      this.records = await this.loadRecords();
      this.graphRecords = await this.loadGraphs();
      const targets = new Set(ids);
      for (const id of Object.keys(this.records))
        if (!this.infos.has(id)) targets.add(id);
      const drops: Array<[string, string[]]> = [];
      for (const id of targets) {
        const record = this.records[id];
        if (!record) continue;
        drops.push([id, await this.compute(id, record)]);
      }
      const stopped = await this.computeGraphs();
      this.emit();
      for (const [id, rids] of drops)
        if (rids.length > 0) await this.dropRequests(id, rids);
      if (stopped.length > 0) await this.clearPending(stopped);
      await this.closeEndedHelpers();
      for (const check of [...this.checks]) check();
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

  /**
   * Helpers leave the panel once the call that started them ended: their
   * result reached the agent, or the agent was interrupted. Storage keeps
   * them, and `/agents` shows them.
   */
  private async closeEndedHelpers(): Promise<void> {
    const ended: string[] = [];
    for (const [id, graph] of Object.entries(this.graphRecords)) {
      if (!graph.owner || graph.closed) continue;
      if (
        (await this.isFinished(Number(id))) &&
        (await this.isFinished(graph.owner.tool))
      )
        ended.push(id);
    }
    if (ended.length === 0) return;
    await this.harness.commit(async (tx) => {
      const graphs = (await tx.doc(GraphsDoc)).graphs;
      const agents = (await tx.doc(AgentsDoc)).agents;
      for (const id of ended) {
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
    this.graphRecords = await this.loadGraphs();
    this.records = await this.loadRecords();
    for (const id of ended) {
      const info = this.graphInfos.get(id);
      if (info) info.closed = true;
      for (const node of this.graphRecords[id]?.nodes ?? []) {
        const agent = this.infos.get(node.agent);
        const record = this.records[node.agent];
        if (agent && record) agent.closed = record.closed;
      }
    }
    this.emit();
  }

  /** A stopped graph delivers nothing. */
  private async clearPending(graphIds: string[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(GraphsDoc);
      for (const id of graphIds) {
        const graph = state.graphs[id];
        if (graph) graph.pending = false;
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

    const taskAnswer = await this.taskAnswer(id, record);
    const result: AgentResult | undefined = resultOf(
      this.lastAssistant.get(id),
      id,
      record.name,
    );
    const state =
      (live?.run === undefined
        ? await this.nodeState(id, record, result)
        : undefined) ?? deriveState(live, result, this.settlements.get(id));
    const ended = this.endedTurns.get(id);
    const previous = this.infos.get(id);
    const now = Date.now();
    const endedAt =
      state === "working" || state === "waiting"
        ? undefined
        : await this.agentEndedAt(id, record);
    const durable = (agent ?? {}) as DurableAgentState;
    const tools = Array.isArray(durable.tools)
      ? durable.tools.filter((tool) => tool !== DELEGATE_TOOL)
      : undefined;
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
      ...(taskAnswer !== undefined ? { taskAnswer } : {}),
      ...(record.graph ? { graph: record.graph } : {}),
      ...(record.delegate ? { delegates: true } : {}),
      ...(state === "idle" &&
      [...outcomes.values()].some((outcome) => outcome.kind === "answered")
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
    let latest = this.generations.get(agentId);
    if (latest === undefined) {
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
      latest = task
        ? {
            task: Number(task.id),
            ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
          }
        : null;
      // A commit may have seen a newer generation meanwhile.
      const known = this.generations.get(agentId);
      if (known && (!latest || known.task > latest.task)) latest = known;
      else this.generations.set(agentId, latest);
    }
    if (latest) return latest.endedAt;
    const graph =
      record.graph === undefined ? undefined : this.graphRecords[record.graph];
    const node = graph?.nodes.find((each) => each.agent === agentId);
    return node ? (await this.settledTask(node.task))?.endedAt : undefined;
  }

  /**
   * The entry that answered the agent's task: the answer to the submission
   * of its task, under `parent:1` for agents the parent started and under
   * its node's request ID for a graph's agents.
   */
  private async taskAnswer(
    agentId: string,
    record: AgentRecord,
  ): Promise<number | undefined> {
    const cached = this.taskAnswers.get(agentId);
    if (cached !== undefined) return cached ?? undefined;
    const graph =
      record.graph === undefined ? undefined : this.graphRecords[record.graph];
    const node = graph?.nodes.find((each) => each.agent === agentId);
    const rid = node ? nodeRequestId(node.task) : requestId(1);
    const submission = await this.harness.commit(
      (tx) => tx.submissionByRequest(conversationId(agentId), rid),
      CONTEXT,
    );
    if (submission?.type !== "input") return undefined;
    if (submission.status === "done") {
      this.taskAnswers.set(agentId, submission.answer);
      return submission.answer;
    }
    if (submission.status === "unanswered") this.taskAnswers.set(agentId, null);
    return undefined;
  }

  /**
   * A graph agent's state while its own conversation doesn't run: it waits
   * until its inputs ended, then works until its node ended, also before the
   * node sent the task. An agent that never answered shows why: skipped, or
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
    const outcome = await this.taskOutcome(node.task);
    if (outcome === undefined) {
      for (const input of node.after) {
        const task = graph.nodes.find((each) => each.agent === input)?.task;
        if (task !== undefined && !(await this.isFinished(task)))
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

  /**
   * A task's outcome once decided. A task can hold its outcome while work it
   * owns still runs, such as a user's message to a graph's agent; it is
   * `terminal` only after that work drained.
   */
  private async settledTask(
    id: number,
  ): Promise<
    | { outcome: TaskOutcome<JsonValue>; terminal: boolean; endedAt?: number }
    | undefined
  > {
    const cached = this.outcomes.get(id);
    if (cached?.terminal) return cached;
    const record = await this.harness.getTask(taskId(id), CONTEXT);
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
  private async taskOutcome(
    id: number,
  ): Promise<TaskOutcome<JsonValue> | undefined> {
    return (await this.settledTask(id))?.outcome;
  }

  /** Whether a task finished: terminal, with nothing below it running. */
  private async isFinished(id: number): Promise<boolean> {
    return (await this.settledTask(id))?.terminal === true;
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

  /** How a graph agent's node ended, once it did. */
  private async nodeOutcome(
    task: number,
    agentId: string,
    name: string,
  ): Promise<NodeOutcome | undefined> {
    const outcome = await this.taskOutcome(task);
    if (!outcome) return undefined;
    switch (outcome.status) {
      case "completed": {
        const result = outcome.result as NodeResult;
        if (result.kind === "skipped") return { kind: "skipped" };
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

  /** Recompute every graph's info; returns stopped graphs still pending. */
  private async computeGraphs(): Promise<string[]> {
    const stopped: string[] = [];
    const now = Date.now();
    for (const [id, record] of Object.entries(this.graphRecords)) {
      // A graph works until it is terminal, also while it holds an outcome.
      const settled = await this.settledTask(Number(id));
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
      const previous = this.graphInfos.get(id);
      this.graphInfos.set(id, {
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
            const usage = this.infos.get(node.agent)?.usage;
            return usage ? [usage] : [];
          }),
        ),
        ...(record.owner ? { owner: record.owner.agent } : {}),
        ...(record.pending && ended !== undefined && !isStopped
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
    for (const graph of this.graphInfos.values())
      if (graph.owner)
        owned.set(graph.owner, [...(owned.get(graph.owner) ?? []), graph]);
    for (const graph of this.graphInfos.values()) {
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
    for (const info of this.infos.values()) {
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
