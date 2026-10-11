/**
 * Delivery: results due to the parent, those handed over but not yet held,
 * and their acknowledgment. Delivery is serialized and repeats after a crash.
 */

import type { AgentLookup, Parent } from "./parent.js";
import { isSettled, type Projection } from "./projection.js";
import {
  answerDeliveryId,
  failureDeliveryId,
  graphDeliveryId,
} from "./records.js";
import type { AgentStore } from "./store.js";
import {
  type AgentDelivery,
  AgentError,
  type GraphDelivery,
  type PendingDelivery,
} from "./types.js";
import type { Holds } from "./waits.js";

interface DeliveryOptions {
  parent: Parent;
  store: AgentStore;
  projection: Projection;
  holds: Holds;
  lookup: AgentLookup;
  refresh: (ids: string[]) => Promise<void>;
  report: (error: unknown) => void;
  isClosed: () => boolean;
}

export class Delivery {
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
  private readonly options: DeliveryOptions;

  constructor(options: DeliveryOptions) {
    this.options = options;
  }

  carried(id: string): boolean {
    return this.inFlight.get(id)?.carried === true;
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  markCarried(ids: string[], call?: string): void {
    // In flight until the parent holds the call's result; no longer
    // queued meanwhile.
    for (const id of ids)
      this.inFlight.set(id, {
        carried: true,
        ...(call === undefined ? {} : { call }),
      });
  }

  async settle(): Promise<void> {
    await this.deliveryChain;
  }

  /**
   * Results to deliver: finished graphs the parent still expects, and
   * settled parent requests. Agents and graphs under a wait are excluded, and
   * so are agents whose graph's result is still due.
   */
  pending(): PendingDelivery[] {
    return this.deliveries(false);
  }

  /** Undelivered results; `withheld` adds those a wait or a graph holds. */
  private deliveries(withheld: boolean): PendingDelivery[] {
    const deliveries: PendingDelivery[] = [];
    for (const graphId of Object.keys(this.options.projection.graphs())) {
      if (!withheld && this.options.holds.isGraphAwaited(graphId)) continue;
      const delivery = this.graphDelivery(graphId);
      if (delivery) deliveries.push(delivery);
    }
    for (const agentId of this.options.projection.settledIds()) {
      const record = this.options.projection.agents()[agentId];
      if (!record) continue;
      if (
        !withheld &&
        (this.options.holds.isAwaited(agentId) ||
          this.options.projection.isHeldByGraph(record))
      )
        continue;
      deliveries.push(...this.agentDeliveries(agentId));
    }
    return deliveries;
  }

  /** A finished graph's result, while the parent still expects it. */
  graphDelivery(graphId: string): GraphDelivery | undefined {
    const record = this.options.projection.graphs()[graphId];
    const info = this.options.projection.graphInfo(graphId);
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
  agentDeliveries(agentId: string): AgentDelivery[] {
    const record = this.options.projection.agents()[agentId];
    const outcomes = this.options.projection.settledOf(agentId);
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
  schedule(): void {
    if (this.deliveryQueued || this.options.isClosed()) return;
    this.deliveryQueued = true;
    this.deliveryChain = this.deliveryChain
      .then(async () => {
        this.deliveryQueued = false;
        if (!this.options.isClosed()) await this.deliverDue();
      })
      .catch((error) => this.options.report(error));
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
      this.pending().filter((each) => !this.inFlight.has(each.id));
    // Ask the parent only when it may hold something new: results in
    // flight, results about to go out, and, once, those of a past process.
    if (
      this.reconciled &&
      this.inFlight.size === 0 &&
      (due().length === 0 || !this.options.parent.canDeliver())
    )
      return;
    this.reconciled = true;
    if (ids.size === 0) return;
    const received = await this.options.parent.received(
      [...ids].map((id) => {
        const call = this.inFlight.get(id)?.call;
        return call === undefined ? { id } : { id, call };
      }),
    );
    await this.acknowledgeAll(all.filter((each) => received.has(each.id)));
    const next = due();
    if (next.length === 0 || !this.options.parent.canDeliver()) return;
    for (const each of next) this.inFlight.set(each.id, { carried: false });
    try {
      await this.options.parent.deliver(next, this.options.lookup);
    } catch (error) {
      // Due again; the next pass first acknowledges what the parent holds.
      for (const each of next) this.inFlight.delete(each.id);
      throw error;
    }
  }

  /**
   * A wait also consumes successful answers to user prompts. They have no
   * delivery to acknowledge, for example after an interrupted parent request
   * was dropped; close them now, unless the graph still holds the answer.
   */
  async consumeUnrequested(agentIds: readonly string[]): Promise<void> {
    const consumed = agentIds.filter((id) => {
      const record = this.options.projection.agents()[id];
      const info = this.options.projection.info(id);
      return (
        record !== undefined &&
        info?.state === "idle" &&
        !info.closed &&
        info.result !== undefined &&
        Object.keys(record.requests).length === 0 &&
        !this.options.projection.isHeldByGraph(record)
      );
    });
    if (consumed.length === 0) return;
    await this.options.store.closeUnrequested(consumed);
    await this.options.refresh(consumed);
  }

  /** Mark a delivery done. An answered agent closes, and so does a graph. */
  async acknowledge(delivery: PendingDelivery): Promise<void> {
    await this.acknowledgeAll([delivery]);
  }

  /** Mark deliveries done, an agent's together, so it closes once an answer
   * reached the parent and no request remains. */
  async acknowledgeAll(deliveries: readonly PendingDelivery[]): Promise<void> {
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

  /**
   * A graph's result reached the parent: the graph closes, and so do its
   * agents that answered, never started, or that the graph stopped. Their
   * answers count as delivered, so parent messages answered by the same
   * entry deliver with the graph. Failed and interrupted agents stay open.
   */
  private async consumeGraph(graphId: string): Promise<void> {
    const info = this.options.projection.graphInfo(graphId);
    if (!info) throw new AgentError(`No graph with ID ${graphId}`);
    await this.options.store.consumeGraph(graphId, info.nodes, (id) =>
      this.options.projection.settledOf(id),
    );
    await this.options.refresh(info.nodes.map((node) => node.agentId));
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
    await this.options.store.removeRequests(agentId, requestIds, entryIds);
    for (const rid of requestIds)
      this.options.projection.deleteSettled(agentId, rid);
    await this.options.refresh([agentId]);
  }
}
