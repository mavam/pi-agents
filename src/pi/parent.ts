/**
 * The parent inside Pi: Pi's session. Results post as messages while the
 * session is idle and no agent is attached; the last one starts a turn. A
 * steer from the user ends the session's waits for agents, because Pi
 * places a steering message only after the current tool round.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentLookup,
  type Attention,
  AttentionSignals,
  type Parent,
} from "../agents/parent.js";
import type { PendingDelivery } from "../agents/types.js";
import {
  GRAPH_RESULT_MESSAGE,
  type GraphResultDetails,
  graphContent,
  graphResultDetails,
  RESULT_MESSAGE,
  type ResultDetails,
  resultContent,
  resultDetails,
} from "./messages.js";

/** The parent message of one delivery: one per agent answer or graph. */
function message(
  delivery: PendingDelivery,
  lookup: AgentLookup,
): {
  customType: string;
  content: string;
  display: boolean;
  details: GraphResultDetails | ResultDetails;
} {
  if (delivery.kind === "graph") {
    const graph = lookup.getGraph(delivery.graphId);
    const details = graphResultDetails(
      {
        id: delivery.graphId,
        name: delivery.name,
        policy: graph?.policy ?? "allSettled",
      },
      delivery.nodes,
      (agentId) => lookup.get(agentId),
    );
    return {
      customType: GRAPH_RESULT_MESSAGE,
      content: graphContent(details),
      display: true,
      details,
    };
  }
  const details = resultDetails(delivery, lookup.get(delivery.agentId));
  return {
    customType: RESULT_MESSAGE,
    content: resultContent(details),
    display: true,
    details,
  };
}

export class PiParent implements Parent {
  private ctx: ExtensionContext | undefined;
  private blocked: () => boolean = () => false;
  private readonly listeners = new Set<() => void>();
  private readonly waits = new AttentionSignals();

  constructor(private readonly pi: ExtensionAPI) {}

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /** Hold deliveries while the predicate is true, e.g. while attached. */
  setBlocked(blocked: () => boolean): void {
    this.blocked = blocked;
  }

  clear(): void {
    this.ctx = undefined;
  }

  /** Pi changed in a way that may let deliveries proceed. */
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The user steered: end the session's waits, so Pi places the steer. */
  steer(): void {
    this.waits.raise();
  }

  canDeliver(): boolean {
    const ctx = this.ctx;
    if (!ctx || this.blocked()) return false;
    try {
      return ctx.isIdle() && !ctx.hasPendingMessages();
    } catch {
      // A stale context after a session switch; the next one retries.
      return false;
    }
  }

  async deliver(
    deliveries: readonly PendingDelivery[],
    lookup: AgentLookup,
  ): Promise<void> {
    deliveries.forEach((delivery, index) => {
      const wake = index === deliveries.length - 1;
      this.pi.sendMessage(
        message(delivery, lookup),
        wake ? { triggerTurn: true } : undefined,
      );
    });
  }

  attention(): Attention {
    return this.waits.open();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
