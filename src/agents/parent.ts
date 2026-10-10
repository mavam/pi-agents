/**
 * The parent: the conversation that starts agents and receives their
 * results. The core reaches it only through `Parent`, which the host
 * implements: whether it can take results now, how results reach it, and
 * when its waits must end because something needs it. Inside Pi, the parent
 * is Pi's session, and a delivery is a message posted into it. A durable
 * host could deliver by submitting to its main conversation instead.
 */

import type { AgentInfo, GraphInfo, PendingDelivery } from "./types.js";

/** What the parent may read to word deliveries. */
export interface AgentLookup {
  get(nameOrId: string): AgentInfo | undefined;
  getGraph(nameOrId: string): GraphInfo | undefined;
}

/** Ends one wait of the parent; release it once the wait ended. */
export interface Attention {
  /** Aborts once something needs the parent. */
  readonly signal: AbortSignal;
  release(): void;
}

export interface Parent {
  /**
   * Whether the parent takes deliveries now: it doesn't work, holds no
   * queued input, and nothing holds deliveries back, such as the user
   * attached to an agent.
   */
  canDeliver(): boolean;
  /** Hand deliveries to the parent, in order; the last may start a turn. */
  deliver(
    deliveries: readonly PendingDelivery[],
    lookup: AgentLookup,
  ): Promise<void>;
  /**
   * A signal for one of the parent's waits. It aborts once something needs
   * the parent, such as the user steering, so the wait ends and the parent
   * can answer while its agents keep working.
   */
  attention(): Attention;
  /** Listen for changes that may let deliveries proceed. */
  subscribe(listener: () => void): () => void;
}

/** The attention signals of the parent's open waits; they abort together. */
export class AttentionSignals {
  private readonly controllers = new Set<AbortController>();

  open(): Attention {
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      release: () => this.controllers.delete(controller),
    };
  }

  /** Something needs the parent: end every open wait. */
  raise(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
