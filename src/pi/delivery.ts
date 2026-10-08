/**
 * Delivery of agent results into the parent conversation. Results post only
 * while the parent is idle and no agent is attached; the last one starts a
 * parent turn. A result is acknowledged after posting, so a crash may repeat
 * a delivery but never lose one.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PendingDelivery } from "../agents/types.js";
import { RESULT_MESSAGE, resultContent, resultDetails } from "./messages.js";
import type { SessionHost } from "./session.js";

function deliveryKey(delivery: PendingDelivery): string {
  return `${delivery.agentId}:${delivery.requestIds.join(",")}`;
}

export class DeliveryManager {
  private ctx: ExtensionContext | undefined;
  private flushing = false;
  /** Posted deliveries whose acknowledgement is still in flight. */
  private readonly posted = new Set<string>();
  private blocked: () => boolean = () => false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly host: SessionHost,
  ) {}

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /** Hold deliveries while the predicate is true, e.g. while attached. */
  setBlocked(blocked: () => boolean): void {
    this.blocked = blocked;
  }

  clear(): void {
    this.ctx = undefined;
    this.posted.clear();
  }

  private canDeliver(ctx: ExtensionContext): boolean {
    if (this.blocked()) return false;
    if (!ctx.isIdle()) return false;
    return !ctx.hasPendingMessages();
  }

  /** Post every pending result if the parent can take them now. */
  flush(ctx?: ExtensionContext): void {
    if (ctx) this.ctx = ctx;
    const context = this.ctx;
    const service = this.host.current();
    if (!context || !service || this.flushing) return;
    let deliveries: PendingDelivery[];
    try {
      if (!this.canDeliver(context)) return;
      deliveries = service
        .pendingDeliveries()
        .filter((delivery) => !this.posted.has(deliveryKey(delivery)));
    } catch {
      // A stale context after a session switch; the next one retries.
      return;
    }
    if (deliveries.length === 0) return;
    this.flushing = true;
    try {
      deliveries.forEach((delivery, index) => {
        const wake = index === deliveries.length - 1;
        const details = resultDetails(delivery, service.get(delivery.agentId));
        this.pi.sendMessage(
          {
            customType: RESULT_MESSAGE,
            content: resultContent(details),
            display: true,
            details,
          },
          wake ? { triggerTurn: true } : undefined,
        );
        const key = deliveryKey(delivery);
        this.posted.add(key);
        void service
          .acknowledge(delivery)
          .catch(() => {})
          .finally(() => this.posted.delete(key));
      });
    } finally {
      this.flushing = false;
    }
  }
}
