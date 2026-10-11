/**
 * AgentService: the agent abstraction over one pi-durable Harness, the
 * core of pi-agents. The host opens the harness with pi-agents' extensions
 * installed (see extensions.ts) and hands it over with the anchor, the
 * conversation that owns the parent's graphs; the service never opens
 * storage or a harness and never closes them.
 *
 * Standalone agents are ownerless conversations, so aborting other work
 * never reaches them. A graph's agents are conversations owned by the node
 * tasks of the graph (see graphs.ts). The service keeps a derived
 * `AgentInfo` per agent and a `GraphInfo` per graph, refreshed from commit
 * publications, and tracks parent requests and graph results until they are
 * delivered. It reaches the parent only through `Parent` (see parent.ts):
 * it hands results over when the parent can take them, and ends the
 * parent's waits when the parent is needed.
 */

import type { AttachedReplicatedState } from "@earendil-works/chord";
import {
  type Conversation,
  type ConversationView,
  configure,
  type Extension,
  type Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { DEFAULT_AGENT_TOOLS } from "../host/tools.js";
import { CONTEXT, contextFor, conversationId, taskId } from "./context.js";
import { DELEGATE_TOOL } from "./delegation.js";
import { type AgentExtensions, agentSelection } from "./extensions.js";
import { GraphTask, NodeTask } from "./graphs.js";
import { MessageLog } from "./message-log.js";
import { claimName, NAME_BASE_LENGTH, takenNames } from "./names.js";
import { HarnessObserver } from "./observer.js";
import type { Parent } from "./parent.js";
import { Projection } from "./projection.js";
import {
  AgentsDoc,
  answerDeliveryId,
  failureDeliveryId,
  GraphsDoc,
  graphDeliveryId,
  type ParentRequest,
  requestId,
} from "./records.js";
import { AgentStore } from "./store.js";
import { resolveEdges } from "./topology.js";
import {
  type AgentDelivery,
  AgentError,
  type AgentInfo,
  GRAPH_SIZE,
  type GraphDelivery,
  type GraphInfo,
  type GraphNode,
  type GraphPolicy,
  type GraphSpec,
  isThinkingLevel,
  type MessageInfo,
  type NodeOutcome,
  type PendingDelivery,
  type SendMode,
  type SpawnSpec,
  type Target,
  type TargetRef,
  type TaskNode,
  USER_MESSAGE_PREFIX,
  WaitInterrupted,
} from "./types.js";

const REFRESH_DELAY_MS = 50;

export interface AgentServiceOptions {
  /** The harness the host opened, with `extensions` installed. */
  harness: Harness;
  /** The conversation that owns the graphs the parent starts. */
  anchor: Conversation;
  extensions: AgentExtensions;
  /** The conversation that starts agents and receives their results. */
  parent: Parent;
  /** Receives failures of background work, such as delivery. */
  onReport?: (error: unknown) => void;
  /** How long the service gathers commits before it refreshes; tests
   * shorten it. */
  refreshDelayMs?: number;
}

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The parent call that waits, whose result carries the results to the
   * parent; `call` is its key, if it has one, by which the parent
   * recognizes the result where it doesn't name the results, such as a
   * nested call's. */
  carrier?: { call?: string };
}

export interface WaitOutcome {
  agents: AgentInfo[];
  graphs: GraphInfo[];
  /** Agents and graphs still working when the wait timed out. */
  timedOut: string[];
  /** The results the wait took instead of their delivery, by ID. */
  deliveries: string[];
}

/** Open agents, and closed ones that work again. */
export function isVisible(info: AgentInfo): boolean {
  return !info.closed || info.state === "working";
}

/** Open graphs, and closed ones still working. */
export function isGraphVisible(info: GraphInfo): boolean {
  return !info.closed || info.state === "working";
}

/** The graph ended and every agent's job has an outcome. */
function isSettled(
  info: GraphInfo,
): info is GraphInfo & { nodes: Array<GraphNode & { outcome: NodeOutcome }> } {
  return (
    info.state !== "working" &&
    info.nodes.every((node) => node.outcome !== undefined)
  );
}

export class AgentService {
  private readonly waiters = new Map<string, number>();
  private readonly graphWaiters = new Map<string, number>();
  /** Checks run after every refresh, for waits on graphs and nodes. */
  private readonly checks = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private unsubscribeParent: (() => void) | undefined;
  private deliveryChain: Promise<void> = Promise.resolve();
  private deliveryQueued = false;
  /** Deliveries handed to the parent that it doesn't hold yet: posted, or
   * carried by the result of a parent call's wait, with that call's key.
   * In memory only: after a restart, the parent decides what it holds, and
   * what it doesn't hold goes out again. */
  private readonly inFlight = new Map<
    string,
    { carried: boolean; call?: string }
  >();
  /** Whether delivery asked the parent what it holds since starting. */
  private reconciled = false;
  private closed = false;

  private readonly projection: Projection;
  private readonly messageLog: MessageLog;
  private readonly observer: HarnessObserver;
  private readonly store: AgentStore;
  private readonly harness: Harness;
  private readonly anchor: Conversation;
  private readonly extensions: AgentExtensions;
  private readonly parent: Parent;
  private readonly report: (error: unknown) => void;
  private readonly refreshDelayMs: number;

  private constructor(options: AgentServiceOptions) {
    this.harness = options.harness;
    this.store = new AgentStore({ harness: this.harness });
    this.anchor = options.anchor;
    this.extensions = options.extensions;
    this.parent = options.parent;
    this.report = options.onReport ?? (() => {});
    this.refreshDelayMs = options.refreshDelayMs ?? REFRESH_DELAY_MS;
    this.messageLog = new MessageLog({
      store: this.store,
      agents: () => this.projection.agents(),
    });
    this.observer = new HarnessObserver({
      harness: this.harness,
      store: this.store,
      graphOfNode: (task) => this.projection.graphOfNode(task),
      onChange: () => this.scheduleRefresh(),
      onMessage: (submission) => this.messageLog.noteSubmission(submission),
      onMessagesChanged: () => this.messageLog.markDirty(),
      isMessagesDirty: () => this.messageLog.isDirty(),
      agentIds: () => Object.keys(this.projection.agents()),
    });
    this.projection = new Projection({
      harness: this.harness,
      store: this.store,
      observer: this.observer,
      carried: (id) => this.inFlight.get(id)?.carried === true,
    });
    this.extensions.hub.state = (id) => this.projection.info(id)?.state;
  }

  /**
   * Start the service over the host's harness. The host resumes the harness
   * afterwards, so recovered work continues under the service's eyes.
   */
  static async start(options: AgentServiceOptions): Promise<AgentService> {
    const service = new AgentService(options);
    try {
      await service.initialize();
    } catch (error) {
      await service.close();
      throw error;
    }
    return service;
  }

  // --- Lifecycle ---

  private async initialize(): Promise<void> {
    this.observer.start();
    await this.projection.reload();
    for (const id of Object.keys(this.projection.agents())) {
      await this.observer.loadLastAssistant(id);
      // A request recorded before a crash may lack its submission.
      await this.store.flushOutbox(id);
    }
    await this.store.flushMessages();
    await this.messageLog.load();
    await this.refresh(Object.keys(this.projection.agents()));
    this.unsubscribeParent = this.parent.subscribe(() =>
      this.scheduleDelivery(),
    );
  }

  /** Stop observing the harness; the host closes it afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.extensions.hub.state = () => undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.observer.stop();
    this.unsubscribeParent?.();
    this.listeners.clear();
    for (const check of [...this.checks]) check();
    await this.refreshChain.catch(() => {});
    await this.deliveryChain;
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
    return [...this.projection.infos()]
      .filter((info) => options.includeClosed || isVisible(info))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Visible graphs, oldest first; `includeClosed` adds closed ones. */
  graphs(options: { includeClosed?: boolean } = {}): GraphInfo[] {
    return [...this.projection.graphInfos()]
      .filter((info) => options.includeClosed || isGraphVisible(info))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** How many older messages the log dropped. */
  droppedMessages(): number {
    return this.messageLog.dropped();
  }

  /** Messages between agents, oldest first. */
  messages(): MessageInfo[] {
    return this.messageLog.list();
  }

  /** A visible agent by name, else the newest closed one, else by ID. */
  get(nameOrId: string): AgentInfo | undefined {
    const named = this.list({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return (
      named.find(isVisible) ?? named.at(-1) ?? this.projection.info(nameOrId)
    );
  }

  /** A visible graph by name, else the newest closed one, else by ID. */
  getGraph(nameOrId: string): GraphInfo | undefined {
    const named = this.graphs({ includeClosed: true }).filter(
      (info) => info.name === nameOrId,
    );
    return (
      named.find(isGraphVisible) ??
      named.at(-1) ??
      this.projection.graphInfo(nameOrId)
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

  /** An agent by its immutable ID, which no name can shadow. */
  agentById(id: string): AgentInfo | undefined {
    return this.projection.info(id);
  }

  /** A graph by its immutable ID, which no name can shadow. */
  graphById(id: string): GraphInfo | undefined {
    return this.projection.graphInfo(id);
  }

  private require(nameOrId: string): AgentInfo {
    const info = this.get(nameOrId);
    if (!info) throw new AgentError(`No agent named ${nameOrId}`);
    return info;
  }

  private requireAgent(id: string): AgentInfo {
    const info = this.projection.info(id);
    if (!info) throw new AgentError(`No agent with ID ${id}`);
    return info;
  }

  private requireGraph(id: string): GraphInfo {
    const info = this.projection.graphInfo(id);
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

  // --- Operations ---

  /** Create an agent and send it its job. */
  async spawn(spec: SpawnSpec): Promise<AgentInfo> {
    // Fail early with the service's view; the commit claims for real.
    claimName(spec.name, spec.profile ?? "agent", this.takenNames(), "agent");
    const { job, tools } = this.prepare(spec);
    const first = requestId(1);
    const request: ParentRequest = { message: job, whenBusy: "followUp" };
    const createdAt = Date.now();
    const id = await this.harness.commit(async (tx) => {
      const state = await tx.doc(AgentsDoc);
      const name = claimName(
        spec.name,
        spec.profile ?? "agent",
        takenNames(state, await tx.doc(GraphsDoc), this.workingClosed()),
        "agent",
      );
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, conversation.id, {
        cwd: spec.cwd,
        ...this.capabilities(tools, spec.delegate),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
      });
      state.agents[String(conversation.id)] = {
        name,
        profile: spec.profile ?? null,
        job,
        createdAt,
        closed: false,
        ambientSkills: spec.ambientSkills ?? true,
        nextRequest: 2,
        requests: { [first]: request },
        delivered: [],
        ...(spec.delegate ? { delegate: true } : {}),
      };
      return String(conversation.id);
    }, CONTEXT);
    await this.store.submit(id, first, request);
    await this.refresh([id]);
    return this.requireAgent(id);
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
    const created = await this.anchor.commit(async (tx) => {
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
          { message: node.job },
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
          job: node.job,
          createdAt,
          closed: false,
          ambientSkills: node.spec.ambientSkills ?? true,
          // The node sends the job; parent requests are later messages.
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
  async send(
    nameOrId: string,
    message: string,
    mode: SendMode,
  ): Promise<AgentInfo> {
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
    const rid = await this.store.addRequest(info.id, info.name, request);
    await this.store.submit(info.id, rid, request);
    await this.refresh([info.id]);
    return this.requireAgent(info.id);
  }

  /** Message an agent on behalf of the user; results stay in the agent. */
  async prompt(nameOrId: string, text: string, mode: SendMode): Promise<void> {
    const info = this.require(nameOrId);
    const conversation = await this.harness.conversation(
      conversationId(info.id),
      CONTEXT,
    );
    if (!conversation) throw new AgentError(`Agent ${info.name} is missing`);
    if (this.projection.agents()[info.id]?.stopped)
      await this.store.clearStopped(info.id);
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
    await this.refresh(this.projection.withHelpers([info.id]));
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
    return { kind: "agent", info: this.requireAgent(target.info.id) };
  }

  /**
   * Stop an agent in its turn, so a send from another agent lands before
   * the stop, and the interrupt withdraws or aborts it, or after it, and is
   * refused. The interrupt comes first: a crash before the stop is recorded
   * leaves an interrupted agent, never a stopped one whose work resumes.
   */
  private async stopAgent(agentId: string): Promise<void> {
    await this.extensions.hub.turn(agentId, async () => {
      const conversation = await this.harness.conversation(
        conversationId(agentId),
        CONTEXT,
      );
      await conversation?.abort(CONTEXT);
      await this.store.markStopped(agentId);
    });
    this.projection.clearSettled(agentId);
    await this.refresh(this.projection.withHelpers([agentId]));
  }

  private async stopGraph(graphId: string): Promise<void> {
    const info = this.requireGraph(graphId);
    const finished = await this.observer.isFinished(Number(graphId));
    await this.store.stopGraph(graphId, !finished);
    // Aborting the graph aborts its nodes, and they their agents, bottom-up.
    if (!finished) {
      await this.harness.abortTask(taskId(graphId), CONTEXT);
      await this.harness.waitForTask(taskId(graphId), CONTEXT);
    }
    // Agents may work beyond their job, for example on a user's message.
    for (const node of info.nodes) await this.stopAgent(node.agentId);
    await this.refresh(
      this.projection.withHelpers(info.nodes.map((node) => node.agentId)),
    );
  }

  /**
   * Wait until the agents are idle and the graphs finished, and return
   * them. The wait takes their results instead of their delivery: when a
   * parent call waits (`carrier`), its result carries them, so they count
   * as delivered once the parent holds that result; otherwise the caller
   * takes them, and they count at once. Aborting `signal` ends only the
   * wait, and so does the parent's attention: either throws
   * `WaitInterrupted`.
   */
  async wait(names: string[], options: WaitOptions = {}): Promise<WaitOutcome> {
    return this.waitFor(
      names.map((name) => {
        const target = this.requireTarget(name);
        return { kind: target.kind, id: target.info.id };
      }),
      options,
    );
  }

  /** `wait`, for agents and graphs by their IDs. */
  async waitFor(
    targets: readonly TargetRef[],
    options: WaitOptions = {},
  ): Promise<WaitOutcome> {
    for (const target of targets)
      if (target.kind === "agent") this.requireAgent(target.id);
      else this.requireGraph(target.id);
    const ids = [
      ...new Set(
        targets.flatMap((target) =>
          target.kind === "agent" ? [target.id] : [],
        ),
      ),
    ];
    const graphIds = [
      ...new Set(
        targets.flatMap((target) =>
          target.kind === "graph" ? [target.id] : [],
        ),
      ),
    ];
    const attention = this.parent.attention();
    const signal = AbortSignal.any(
      [
        options.signal,
        attention.signal,
        ...(options.timeoutMs !== undefined
          ? [AbortSignal.timeout(options.timeoutMs)]
          : []),
      ].filter((each): each is AbortSignal => each !== undefined),
    );
    for (const id of ids) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    for (const id of graphIds)
      this.graphWaiters.set(id, (this.graphWaiters.get(id) ?? 0) + 1);
    const idle = new Set<string>();
    const ended = new Set<string>();
    try {
      await Promise.all([
        ...ids.map(async (id) => {
          // A graph agent's job arrives through its node.
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
      if (options.signal?.aborted) throw new WaitInterrupted("cancelled");
      if (attention.signal.aborted) throw new WaitInterrupted("attention");
      await this.refresh(ids);
      const taken = [
        ...[...ended].flatMap((id) => this.graphDelivery(id) ?? []),
        ...[...idle].flatMap((id) => this.agentDeliveries(id)),
      ].filter((each) => !this.inFlight.has(each.id));
      if (options.carrier === undefined) await this.acknowledgeAll(taken);
      else if (taken.length > 0) {
        // In flight until the parent holds the call's result; no longer
        // queued meanwhile.
        const { call } = options.carrier;
        for (const each of taken)
          this.inFlight.set(each.id, {
            carried: true,
            ...(call === undefined ? {} : { call }),
          });
        await this.refresh(ids);
      }
      return {
        agents: ids.map((id) => this.requireAgent(id)),
        graphs: graphIds.map((id) => this.requireGraph(id)),
        timedOut: [
          ...ids
            .filter((id) => !idle.has(id))
            .map((id) => this.requireAgent(id)),
          ...graphIds
            .filter((id) => !ended.has(id))
            .map((id) => this.requireGraph(id)),
        ].map((info) => info.name),
        deliveries: taken.map((each) => each.id),
      };
    } finally {
      attention.release();
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
      // Results the wait held back are due again.
      this.scheduleDelivery();
    }
  }

  /** Resolve true once the graph settled, false when `signal` aborts first. */
  private untilSettled(
    graphId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const info = this.projection.graphInfo(graphId);
      return info !== undefined && isSettled(info);
    }, signal);
  }

  /** Resolve true once a graph agent's node ended, or at once for others. */
  private untilNodeEnded(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.until(() => {
      const graph = this.projection.info(agentId)?.graph;
      if (graph === undefined) return true;
      const node = this.projection
        .graphInfo(graph)
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
    return this.deliveries(false);
  }

  /** Undelivered results; `withheld` adds those a wait or a graph holds. */
  private deliveries(withheld: boolean): PendingDelivery[] {
    const deliveries: PendingDelivery[] = [];
    for (const graphId of Object.keys(this.projection.graphs())) {
      if (!withheld && this.isGraphAwaited(graphId)) continue;
      const delivery = this.graphDelivery(graphId);
      if (delivery) deliveries.push(delivery);
    }
    for (const agentId of this.projection.settledIds()) {
      const record = this.projection.agents()[agentId];
      if (!record) continue;
      if (
        !withheld &&
        (this.isAwaited(agentId) || this.projection.isHeldByGraph(record))
      )
        continue;
      deliveries.push(...this.agentDeliveries(agentId));
    }
    return deliveries;
  }

  /** A finished graph's result, while the parent still expects it. */
  private graphDelivery(graphId: string): GraphDelivery | undefined {
    const record = this.projection.graphs()[graphId];
    const info = this.projection.graphInfo(graphId);
    if (!record?.pending || !info || !isSettled(info) || info.stopped)
      return undefined;
    return {
      kind: "graph",
      id: graphDeliveryId(graphId, record),
      graphId,
      name: info.name,
      nodes: info.nodes,
    };
  }

  /** An agent's settled parent requests: one delivery per failure, and one
   * per answer for all the requests it answered. */
  private agentDeliveries(agentId: string): AgentDelivery[] {
    const record = this.projection.agents()[agentId];
    const outcomes = this.projection.settledOf(agentId);
    if (!record || !outcomes) return [];
    const failures: AgentDelivery[] = [];
    const answers = new Map<number, AgentDelivery>();
    for (const [rid, outcome] of outcomes) {
      if (outcome.kind === "aborted") continue;
      if (outcome.kind === "failed") {
        failures.push({
          kind: "agent",
          id: failureDeliveryId(agentId, record, rid),
          agentId,
          name: record.name,
          requestIds: [rid],
          outcome,
        });
        continue;
      }
      const entryId = outcome.result.entryId;
      if (record.delivered.includes(entryId)) continue;
      const existing = answers.get(entryId);
      if (existing) existing.requestIds.push(rid);
      else
        answers.set(entryId, {
          kind: "agent",
          id: answerDeliveryId(agentId, record, entryId),
          agentId,
          name: record.name,
          requestIds: [rid],
          outcome,
        });
    }
    return [...failures, ...answers.values()];
  }

  /**
   * Hand due results to the parent once it can take them, and acknowledge
   * those it holds. Serialized; runs after every refresh, when a wait ends,
   * and when the parent changes.
   */
  private scheduleDelivery(): void {
    if (this.deliveryQueued || this.closed) return;
    this.deliveryQueued = true;
    this.deliveryChain = this.deliveryChain
      .then(async () => {
        this.deliveryQueued = false;
        if (!this.closed) await this.deliverDue();
      })
      .catch((error) => this.report(error));
  }

  /**
   * A delivery counts as done once the parent holds it, never on handing it
   * over: a crash in between repeats it rather than losing it. After a
   * restart, results the parent already holds are acknowledged without
   * handing them over again.
   */
  private async deliverDue(): Promise<void> {
    const all = this.deliveries(true);
    const ids = new Set(all.map((each) => each.id));
    for (const id of this.inFlight.keys())
      if (!ids.has(id)) this.inFlight.delete(id);
    const due = () =>
      this.pendingDeliveries().filter((each) => !this.inFlight.has(each.id));
    // Ask the parent only when it may hold something new: results in
    // flight, results about to go out, and, once, those of a past process.
    if (
      this.reconciled &&
      this.inFlight.size === 0 &&
      (due().length === 0 || !this.parent.canDeliver())
    )
      return;
    this.reconciled = true;
    if (ids.size === 0) return;
    const received = await this.parent.received(
      [...ids].map((id) => {
        const call = this.inFlight.get(id)?.call;
        return call === undefined ? { id } : { id, call };
      }),
    );
    await this.acknowledgeAll(all.filter((each) => received.has(each.id)));
    const next = due();
    if (next.length === 0 || !this.parent.canDeliver()) return;
    for (const each of next) this.inFlight.set(each.id, { carried: false });
    try {
      await this.parent.deliver(next, this);
    } catch (error) {
      // Due again; the next pass first acknowledges what the parent holds.
      for (const each of next) this.inFlight.delete(each.id);
      throw error;
    }
  }

  /** Mark a delivery done. An answered agent closes, and so does a graph. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    await this.acknowledgeAll([delivery]);
  }

  /** Mark deliveries done, an agent's together, so it closes once an answer
   * reached the parent and no request remains. */
  private async acknowledgeAll(
    deliveries: readonly PendingDelivery[],
  ): Promise<void> {
    const byAgent = new Map<string, AgentDelivery[]>();
    for (const delivery of deliveries) {
      this.inFlight.delete(delivery.id);
      if (delivery.kind === "graph") await this.consumeGraph(delivery.graphId);
      else
        byAgent.set(delivery.agentId, [
          ...(byAgent.get(delivery.agentId) ?? []),
          delivery,
        ]);
    }
    for (const [agentId, group] of byAgent)
      await this.removeRequests(
        agentId,
        group.flatMap((delivery) => delivery.requestIds),
        group.flatMap((delivery) =>
          delivery.outcome.kind === "answered"
            ? [delivery.outcome.result.entryId]
            : [],
        ),
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

  /** Validate a spawn's job, thinking level, and tools. */
  private prepare(spec: SpawnSpec): {
    job: string;
    tools: ToolRegistration[];
  } {
    if (spec.thinking !== undefined && !isThinkingLevel(spec.thinking))
      throw new AgentError(`Invalid thinking level: ${spec.thinking}`);
    const tools = this.resolveTools(spec.tools);
    const job = spec.job.trim();
    if (!job) throw new AgentError("The job must not be empty");
    return { job, tools };
  }

  /**
   * The tools and extensions of a new agent, named explicitly, so the
   * harness's default selection never reaches it. A delegating agent also
   * selects the delegation extension and its tool, so only it can start
   * helpers.
   */
  private capabilities(
    tools: ToolRegistration[],
    delegate: boolean | undefined,
  ): { tools: ToolRegistration[]; extensions: Extension[] } {
    const extensions = agentSelection(this.extensions, {
      delegate: !!delegate,
      messaging: true,
    });
    const extra = [
      ...(delegate
        ? (this.extensions.delegation.tools ?? []).filter(
            (each) => each.name === DELEGATE_TOOL,
          )
        : []),
      ...(this.extensions.messaging.tools ?? []),
    ];
    return { tools: [...tools, ...extra], extensions };
  }

  private resolveTools(names: string[] | undefined): ToolRegistration[] {
    const available = [...(this.extensions.tools.tools ?? [])];
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

  /**
   * A graph's result reached the parent: the graph closes, and so do its
   * agents that answered, never started, or that the graph stopped. Their
   * answers count as delivered, so parent messages answered by the same
   * entry deliver with the graph. Failed and interrupted agents stay open.
   */
  private async consumeGraph(graphId: string): Promise<void> {
    const info = this.requireGraph(graphId);
    await this.store.consumeGraph(graphId, info.nodes, (id) =>
      this.projection.settledOf(id),
    );
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
    await this.store.removeRequests(agentId, requestIds, entryIds);
    for (const rid of requestIds) this.projection.deleteSettled(agentId, rid);
    await this.refresh([agentId]);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const ids = this.observer.takeDirty();
      void this.refresh(ids).catch(() => {});
    }, this.refreshDelayMs);
  }

  /** Recompute infos for the given agents and every graph, serialized. */
  private refresh(ids: string[]): Promise<void> {
    const run = this.refreshChain.then(async () => {
      if (this.closed) return;
      await this.projection.reload();
      if (this.messageLog.isDirty()) await this.messageLog.load();
      const { drops, stopped } = await this.projection.refresh(ids);
      this.emit();
      for (const [id, rids] of drops)
        if (rids.length > 0) await this.dropRequests(id, rids);
      if (stopped.length > 0) await this.store.clearPending(stopped);
      await this.closeEndedHelpers();
      for (const check of [...this.checks]) check();
      this.scheduleDelivery();
    });
    this.refreshChain = run.catch(() => {});
    return run;
  }

  private async dropRequests(agentId: string, rids: string[]): Promise<void> {
    await this.store.dropRequests(agentId, rids);
    for (const rid of rids) this.projection.deleteSettled(agentId, rid);
  }

  /**
   * Helpers leave the panel once the call that started them ended: their
   * result reached the agent, or the agent was interrupted. Storage keeps
   * them, and `/agents` shows them.
   */
  private async closeEndedHelpers(): Promise<void> {
    const ended: string[] = [];
    for (const [id, graph] of Object.entries(this.projection.graphs())) {
      if (!graph.owner || graph.closed) continue;
      if (
        (await this.observer.isFinished(Number(id))) &&
        (await this.observer.isFinished(graph.owner.tool))
      )
        ended.push(id);
    }
    if (ended.length === 0) return;
    await this.store.closeGraphs(ended);
    await this.projection.reload();
    this.projection.markClosed(ended);
    this.emit();
  }
}
