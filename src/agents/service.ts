/**
 * AgentService: the facade over the host's harness and anchor, owning the
 * lifecycle, queries, operations, and refresh orchestration. AgentStore
 * commits bookkeeping, HarnessObserver follows commits, MessageLog tracks
 * messages, Projection derives infos, Delivery reaches the parent, Waits
 * holds results and checks wait conditions, and creation validates and
 * creates agents and graphs. The host owns storage and the harness.
 */

import type { AttachedReplicatedState } from "@earendil-works/chord";
import type {
  Conversation,
  ConversationView,
  Harness,
} from "@earendil-works/pi-durable";
import { CONTEXT, contextFor, conversationId, taskId } from "./context.js";
import {
  type CreationDeps,
  createAgent,
  createGraph,
  enableCodemodeModels,
  prepare,
} from "./creation.js";
import { Delivery } from "./delivery.js";
import type { AgentExtensions } from "./extensions.js";
import { MessageLog } from "./message-log.js";
import { claimName } from "./names.js";
import { HarnessObserver } from "./observer.js";
import type { Parent } from "./parent.js";
import { Projection } from "./projection.js";
import { type ParentRequest, requestId } from "./records.js";
import { AgentStore } from "./store.js";
import {
  AgentError,
  type AgentInfo,
  type GraphInfo,
  type GraphSpec,
  type MessageInfo,
  type PendingDelivery,
  type SendMode,
  type SpawnSpec,
  type Target,
  type TargetRef,
  type TaskNode,
  USER_MESSAGE_PREFIX,
  WaitInterrupted,
} from "./types.js";
import { Waits } from "./waits.js";

const REFRESH_DELAY_MS = 50;

export interface AgentServiceOptions {
  /** Host-owned creation hooks, outside the durable transaction. */
  captureExtensionState?: CreationDeps["captureExtensionState"];
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

export class AgentService {
  private readonly listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private unsubscribeParent: (() => void) | undefined;
  private closed = false;

  private readonly creation: CreationDeps;
  private readonly delivery: Delivery;
  private readonly waits: Waits;
  private readonly projection: Projection;
  private readonly messageLog: MessageLog;
  private readonly observer: HarnessObserver;
  private readonly store: AgentStore;
  private readonly harness: Harness;
  private readonly extensions: AgentExtensions;
  private readonly parent: Parent;
  private readonly refreshDelayMs: number;

  private constructor(options: AgentServiceOptions) {
    this.harness = options.harness;
    this.store = new AgentStore({ harness: this.harness });
    this.extensions = options.extensions;
    this.parent = options.parent;
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
      carried: (id) => this.delivery.carried(id),
    });
    this.waits = new Waits({
      projection: this.projection,
      isClosed: () => this.closed,
    });
    this.delivery = new Delivery({
      parent: this.parent,
      store: this.store,
      projection: this.projection,
      holds: this.waits,
      lookup: this,
      refresh: (ids) => this.refresh(ids),
      report: options.onReport ?? (() => {}),
      isClosed: () => this.closed,
    });
    this.creation = {
      harness: this.harness,
      anchor: options.anchor,
      extensions: this.extensions,
      captureExtensionState: options.captureExtensionState,
      takenNames: () => this.takenNames(),
      workingClosed: () => this.workingClosed(),
    };
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
    await enableCodemodeModels(
      this.creation,
      Object.keys(this.projection.agents()),
    );
    for (const id of Object.keys(this.projection.agents())) {
      await this.observer.loadLastAssistant(id);
      // A request recorded before a crash may lack its submission.
      await this.store.flushOutbox(id);
    }
    await this.store.flushMessages();
    await this.messageLog.load();
    await this.refresh(Object.keys(this.projection.agents()));
    this.unsubscribeParent = this.parent.subscribe(() =>
      this.delivery.schedule(),
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
    this.waits.check();
    await this.refreshChain.catch(() => {});
    await this.delivery.settle();
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

  // --- Operations ---

  /** Create an agent and send it its job. */
  async spawn(spec: SpawnSpec): Promise<AgentInfo> {
    // Fail early with the service's view; the commit claims for real.
    claimName(spec.name, spec.profile ?? "agent", this.takenNames(), "agent");
    const { job, tools } = prepare(this.creation, spec);
    const first = requestId(1);
    const request: ParentRequest = { message: job, whenBusy: "followUp" };
    const id = await createAgent(this.creation, spec, {
      job,
      tools,
      first,
      request,
    });
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
    const created = await createGraph(this.creation, spec);
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
   * takes them, and they count at once. Successful answers with no parent
   * request have no delivery; the wait consumes them at once. Aborting
   * `signal` ends only the wait, and so does the parent's attention:
   * either throws `WaitInterrupted`.
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
    this.waits.hold(ids, graphIds);
    const idle = new Set<string>();
    const ended = new Set<string>();
    try {
      await Promise.all([
        ...ids.map(async (id) => {
          // A graph agent's job arrives through its node.
          if (!(await this.waits.untilNodeEnded(id, signal))) return;
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
          if (await this.waits.untilSettled(id, signal)) ended.add(id);
        }),
      ]);
      if (options.signal?.aborted) throw new WaitInterrupted("cancelled");
      if (attention.signal.aborted) throw new WaitInterrupted("attention");
      await this.refresh(ids);
      const taken = [
        ...[...ended].flatMap((id) => this.delivery.graphDelivery(id) ?? []),
        ...[...idle].flatMap((id) => this.delivery.agentDeliveries(id)),
      ].filter((each) => !this.delivery.isInFlight(each.id));
      if (options.carrier === undefined)
        await this.delivery.acknowledgeAll(taken);
      else if (taken.length > 0) {
        const { call } = options.carrier;
        this.delivery.markCarried(
          taken.map((each) => each.id),
          call,
        );
        await this.refresh(ids);
      }
      await this.delivery.consumeUnrequested([...idle]);
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
      this.waits.release(ids, graphIds);
      this.emit();
      // Results the wait held back are due again.
      this.delivery.schedule();
    }
  }

  /**
   * Results to deliver: finished graphs the parent still expects, and
   * settled parent requests. Agents and graphs under a wait are excluded, and
   * so are agents whose graph's result is still due.
   */
  pendingDeliveries(): PendingDelivery[] {
    return this.delivery.pending();
  }

  /** Mark a delivery done. An answered agent closes, and so does a graph. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    await this.delivery.acknowledge(delivery);
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
      this.waits.check();
      this.delivery.schedule();
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
