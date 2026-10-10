/**
 * The parent inside Pi: Pi's session. Results post as messages while the
 * session is idle and no agent is attached; the last one starts a turn. A
 * steer from the user ends the session's waits for agents, because Pi
 * places a steering message only after the current tool round.
 *
 * Pi confirms neither posting nor saving a message, and extensions see
 * `message_end` before Pi saves it. So the session holds a delivery only
 * once one of its entries, on any branch, carries it: a result message, or
 * the stored result of a tool call that returned it. A posted delivery the
 * session doesn't contain yet stays in flight until the next start, which
 * posts it again.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentLookup,
  type Attention,
  AttentionSignals,
  type Handover,
  type Parent,
} from "../agents/parent.js";
import type { PendingDelivery } from "../agents/types.js";
import { issued, qualify } from "./calls.js";
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
    const graph = lookup.graphById(delivery.graphId);
    const details = graphResultDetails(
      {
        id: delivery.graphId,
        name: delivery.name,
        policy: graph?.policy ?? "allSettled",
      },
      delivery.nodes,
      (agentId) => lookup.agentById(agentId),
    );
    return {
      customType: GRAPH_RESULT_MESSAGE,
      content: graphContent(details),
      display: true,
      details: { ...details, delivery: delivery.id },
    };
  }
  const details = resultDetails(delivery, lookup.agentById(delivery.agentId));
  return {
    customType: RESULT_MESSAGE,
    content: resultContent(details),
    display: true,
    details: { ...details, delivery: delivery.id },
  };
}

/** The delivery a result message carries. */
function deliveryOf(details: unknown): unknown {
  return typeof details === "object" && details !== null
    ? (details as { delivery?: unknown }).delivery
    : undefined;
}

/** The deliveries an agent tool's result carries. */
function deliveriesOf(details: unknown): unknown[] {
  const deliveries =
    typeof details === "object" && details !== null
      ? (details as { deliveries?: unknown }).deliveries
      : undefined;
  return Array.isArray(deliveries) ? deliveries : [];
}

/**
 * The entry of the assistant message that issued the call of a tool result:
 * the result's nearest assistant ancestor, if it issued the call.
 */
function issuerOf(
  entry: SessionEntry,
  toolCallId: string,
  byId: ReadonlyMap<string, SessionEntry>,
): string | undefined {
  let current = entry.parentId ? byId.get(entry.parentId) : undefined;
  while (current) {
    if (current.type === "message" && current.message.role === "assistant")
      return issued(current, toolCallId) ? current.id : undefined;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/** How often to check again while a delivery waits for Pi. */
const RECHECK_MS = 1_000;

export class PiParent implements Parent {
  private ctx: ExtensionContext | undefined;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private readonly recheckMs: number;
  private blocked: () => boolean = () => false;
  private readonly listeners = new Set<() => void>();
  private readonly waits = new AttentionSignals();

  constructor(
    private readonly pi: ExtensionAPI,
    options: { recheckMs?: number } = {},
  ) {
    this.recheckMs = options.recheckMs ?? RECHECK_MS;
  }

  /**
   * Follow Pi's events that may let a delivery proceed or confirm one. A
   * run ends with `agent_settled`, a compaction outside a run with
   * `session_compact` or `session_compact_failed`, and a branch summary
   * with `session_tree`; each checks again once the event has passed. Pi
   * saves a message only after extensions saw its `message_end`, so that
   * event checks for saved deliveries afterwards. A new session and the
   * attach view closing are the host's to report.
   */
  listen(): void {
    const later = () => {
      setTimeout(() => this.notify(), 0);
    };
    this.pi.on("message_end", later);
    this.pi.on("agent_settled", (_event, ctx) => {
      this.setContext(ctx);
      later();
    });
    this.pi.on("session_compact", later);
    this.pi.on("session_compact_failed", later);
    this.pi.on("session_tree", later);
  }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /** Hold deliveries while the predicate is true, e.g. while attached. */
  setBlocked(blocked: () => boolean): void {
    this.blocked = blocked;
  }

  clear(): void {
    this.ctx = undefined;
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = undefined;
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
    // A new session or the attach view closing tries again.
    if (!ctx || this.blocked()) return false;
    let ready: boolean;
    try {
      ready = ctx.isIdle() && !ctx.hasPendingMessages();
    } catch {
      // A stale context after a session switch; the next one retries.
      return false;
    }
    if (!ready) this.recheckLater();
    return ready;
  }

  /**
   * Not every state that keeps Pi busy ends with an event: a branch summary
   * that is cancelled or fails emits nothing, and messages an abort left
   * queued can be cleared without one. So while a delivery waits for Pi,
   * check again now and then; the core asks only while one waits.
   */
  private recheckLater(): void {
    if (this.recheck) return;
    this.recheck = setTimeout(() => {
      this.recheck = undefined;
      this.notify();
    }, this.recheckMs);
    this.recheck.unref?.();
  }

  async deliver(
    deliveries: readonly PendingDelivery[],
    lookup: AgentLookup,
  ): Promise<void> {
    // Posted in the same synchronous step as the core's idle check, so
    // none lands in the queue of a run, where an abort could drop it.
    deliveries.forEach((delivery, index) => {
      const wake = index === deliveries.length - 1;
      this.pi.sendMessage(
        message(delivery, lookup),
        wake ? { triggerTurn: true } : undefined,
      );
    });
  }

  async received(handovers: readonly Handover[]): Promise<ReadonlySet<string>> {
    const wanted = new Set(handovers.map((handover) => handover.id));
    const byCall = new Map<string, string[]>();
    for (const { id, call } of handovers)
      if (call !== undefined)
        byCall.set(call, [...(byCall.get(call) ?? []), id]);
    const found = new Set<string>();
    const take = (id: unknown) => {
      if (typeof id === "string" && wanted.has(id)) found.add(id);
    };
    const entries = this.entries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (entry.type === "custom_message") {
        if (
          entry.customType === RESULT_MESSAGE ||
          entry.customType === GRAPH_RESULT_MESSAGE
        )
          take(deliveryOf(entry.details));
        continue;
      }
      if (entry.type !== "message" || entry.message.role !== "toolResult")
        continue;
      const result = entry.message;
      deliveriesOf(result.details).forEach(take);
      // Pi stores no results of nested calls, such as a codemode script's,
      // only their records in the caller's result. The core knows their
      // keys only in memory, so after a restart they deliver again.
      const issuer = issuerOf(entry, result.toolCallId, byId);
      if (issuer === undefined) continue;
      if (!result.isError)
        byCall.get(qualify(issuer, result.toolCallId))?.forEach(take);
      for (const call of result.nestedCalls?.calls ?? [])
        if (call.status === "ok")
          byCall.get(qualify(issuer, call.id))?.forEach(take);
    }
    return found;
  }

  /** Every entry of the session, in the order Pi appended them. */
  private entries(): SessionEntry[] {
    try {
      return this.ctx?.sessionManager.getEntries() ?? [];
    } catch {
      // A stale context after a session switch holds nothing.
      return [];
    }
  }

  attention(): Attention {
    return this.waits.open();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
