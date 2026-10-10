/**
 * The parent inside Pi: Pi's session. Results post as messages while the
 * session is idle and no agent is attached; the last one starts a turn. A
 * steer from the user ends the session's waits for agents, because Pi
 * places a steering message only after the current tool round.
 *
 * Pi confirms neither posting nor saving a message, and extensions see
 * `message_end` before Pi saves it. So the session holds a delivery only
 * once one of its entries, on any branch, carries the delivery's ID: a
 * result message, or the stored result of a tool call that returned it.
 *
 * A posted message is lost only if Pi took it into a run and the run
 * settled without saving it, such as a queued message that Esc cleared. A
 * message posted while Pi settles its last run waits in Pi's deferred
 * actions instead, possibly behind a user's prompt that runs a turn of its
 * own first, and Pi saves it as the first message of its own turn. So it
 * never counts as lost; only a restart posts it again.
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
      details: { ...details, delivery: delivery.id },
    };
  }
  const details = resultDetails(delivery, lookup.get(delivery.agentId));
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

export class PiParent implements Parent {
  private ctx: ExtensionContext | undefined;
  private blocked: () => boolean = () => false;
  private readonly listeners = new Set<() => void>();
  private readonly waits = new AttentionSignals();
  /** Posted deliveries Pi hasn't saved yet: in a run, in a run that
   * settled since, or deferred until Pi settled. */
  private readonly posted = new Map<
    string,
    "running" | "settled" | "deferred"
  >();
  /** Per tool call, the results it returns, and the number of session
   * entries when it did, so only a later result entry counts. */
  private readonly claims = new Map<
    string,
    { ids: readonly string[]; after: number }
  >();

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
    this.claims.clear();
    this.posted.clear();
  }

  /** Pi changed in a way that may let deliveries proceed. */
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** A run of the session settled: messages posted into it are saved by
   * now, or lost. Call it when Pi reports `agent_settled`. */
  settled(): void {
    for (const [id, phase] of this.posted)
      if (phase === "running") this.posted.set(id, "settled");
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
    // The last message starts a run at once, unless Pi is settling its last
    // run and defers it: then Pi still looks idle.
    const phase = this.isIdle() ? "deferred" : "running";
    for (const delivery of deliveries) this.posted.set(delivery.id, phase);
  }

  private isIdle(): boolean {
    try {
      return this.ctx?.isIdle() ?? true;
    } catch {
      return true;
    }
  }

  /**
   * The tool call `toolCallId` returns these results. Its stored result
   * carries their IDs, but Pi stores no results of nested calls, such as a
   * codemode script's; it records the calls in their caller's result. So
   * the results also count once Pi stored a result of the call, or of a
   * call that recorded it, after this.
   */
  claim(toolCallId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.claims.set(toolCallId, { ids, after: this.entries().length });
  }

  async received(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const wanted = new Set(ids);
    const found = new Set<string>();
    const take = (id: unknown) => {
      if (typeof id === "string" && wanted.has(id)) found.add(id);
    };
    const takeClaim = (call: string, index: number) => {
      const claim = this.claims.get(call);
      if (claim && index >= claim.after) claim.ids.forEach(take);
    };
    this.entries().forEach((entry, index) => {
      if (entry.type === "custom_message") {
        if (
          entry.customType === RESULT_MESSAGE ||
          entry.customType === GRAPH_RESULT_MESSAGE
        )
          take(deliveryOf(entry.details));
        return;
      }
      if (entry.type !== "message" || entry.message.role !== "toolResult")
        return;
      const result = entry.message;
      deliveriesOf(result.details).forEach(take);
      if (!result.isError) takeClaim(result.toolCallId, index);
      for (const call of result.nestedCalls?.calls ?? [])
        if (call.status === "ok") takeClaim(call.id, index);
    });
    for (const id of found) this.posted.delete(id);
    return found;
  }

  async dropped(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter((id) => this.posted.get(id) === "settled"));
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
