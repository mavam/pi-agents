/** Structured child-agent state for co-loaded extensions, independent of UI. */

import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "../agents/types.js";

/**
 * Channel carrying complete child-agent lifecycle snapshots.
 */
export const AGENTS_STATE_EVENT = "pi-agents:state";
/**
 * Channel accepting `{ protocol: 1 }` to request the current snapshot.
 */
export const AGENTS_STATE_REQUEST_EVENT = "pi-agents:state:request";

/**
 * Public lifecycle fields; excludes prompts, results, and mutable activity.
 */
export type AgentLifecycleInfo = Readonly<
  Pick<AgentInfo, "id" | "name" | "state" | "closed">
>;

/**
 * A replacement snapshot, ordered within one session publisher instance.
 */
export type AgentsStateSnapshot = Readonly<{
  protocol: 1;
  sessionId: string;
  instanceId: string;
  sequence: number;
  type: "snapshot" | "stopped";
  agents: readonly AgentLifecycleInfo[];
}>;

/**
 * Publishes detached, frozen state snapshots through Pi's event bus.
 * Updates start only after the host restores its session; requests before
 * that point are satisfied by the initial snapshot. No resources are started.
 */
export class AgentStatePublisher {
  private sessionId: string | undefined;
  private instanceId: string | undefined;
  private sequence = 0;
  private lastFingerprint: string | undefined;
  private disposed = false;
  private readonly unsubscribe: () => void;

  /**
   * Register snapshot requests on the bus and read agents from the host.
   */
  constructor(
    private readonly events: EventBus,
    private readonly agents: () => readonly AgentLifecycleInfo[],
  ) {
    this.unsubscribe = events.on(AGENTS_STATE_REQUEST_EVENT, (request) => {
      if (
        typeof request !== "object" ||
        request === null ||
        !("protocol" in request) ||
        request.protocol !== 1
      )
        return;
      this.update(true);
    });
  }

  /**
   * Begin a restored session lifetime and publish its initial state.
   * @param sessionId The owning Pi session's ID.
   */
  start(sessionId: string): void {
    if (this.disposed) return;
    this.stop();
    this.sessionId = sessionId;
    this.instanceId = randomUUID();
    this.sequence = 0;
    this.lastFingerprint = undefined;
    this.update(true);
  }

  /**
   * Publish changed lifecycle fields, or force a snapshot for a requester.
   * @param force Whether to publish even when lifecycle state is unchanged.
   */
  update(force = false): void {
    if (this.disposed || !this.sessionId || !this.instanceId) return;
    const agents = this.agents()
      .map(({ id, name, state, closed }) =>
        Object.freeze({ id, name, state, closed }),
      )
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    const fingerprint = JSON.stringify(agents);
    if (!force && fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.publish(Object.freeze(agents));
  }

  /**
   * Clear live ownership, without claiming persisted agents completed.
   */
  stop(): void {
    if (!this.sessionId || !this.instanceId) return;
    const sessionId = this.sessionId;
    const instanceId = this.instanceId;
    const sequence = ++this.sequence;
    // Clear before emitting so requests or repeated stops cannot resurrect it.
    this.sessionId = undefined;
    this.instanceId = undefined;
    this.lastFingerprint = undefined;
    this.events.emit(
      AGENTS_STATE_EVENT,
      Object.freeze({
        protocol: 1,
        sessionId,
        instanceId,
        sequence,
        type: "stopped",
        agents: Object.freeze([]),
      } satisfies AgentsStateSnapshot),
    );
  }

  /**
   * Release the request listener and publish one final ownership reset.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.stop();
  }

  private publish(agents: readonly AgentLifecycleInfo[]): void {
    if (!this.sessionId || !this.instanceId) return;
    this.events.emit(
      AGENTS_STATE_EVENT,
      Object.freeze({
        protocol: 1,
        sessionId: this.sessionId,
        instanceId: this.instanceId,
        sequence: ++this.sequence,
        type: "snapshot",
        agents,
      } satisfies AgentsStateSnapshot),
    );
  }
}
