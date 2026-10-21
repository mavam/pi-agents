/**
 * Waits: counts the agents and graphs covered by waits, and checks the
 * conditions that end waits after a refresh or when the service closes.
 */

import { isSettled, type Projection } from "./projection.js";

export interface Holds {
  isAwaited(agentId: string): boolean;
  isGraphAwaited(graphId: string): boolean;
}

export class Waits implements Holds {
  private readonly waiters = new Map<string, number>();
  private readonly graphWaiters = new Map<string, number>();
  /** Checks run after every refresh, for waits on graphs and nodes. */
  private readonly checks = new Set<() => void>();
  private readonly projection: Projection;
  private readonly isClosed: () => boolean;

  constructor(options: { projection: Projection; isClosed: () => boolean }) {
    this.projection = options.projection;
    this.isClosed = options.isClosed;
  }

  /** Whether a wait currently covers the agent. */
  isAwaited(agentId: string): boolean {
    return (this.waiters.get(agentId) ?? 0) > 0;
  }

  isGraphAwaited(graphId: string): boolean {
    return (this.graphWaiters.get(graphId) ?? 0) > 0;
  }

  hold(ids: string[], graphIds: string[]): void {
    for (const id of ids) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    for (const id of graphIds)
      this.graphWaiters.set(id, (this.graphWaiters.get(id) ?? 0) + 1);
  }

  release(ids: string[], graphIds: string[]): void {
    for (const [counts, keys] of [
      [this.waiters, ids],
      [this.graphWaiters, graphIds],
    ] as const)
      for (const id of keys) {
        const count = (counts.get(id) ?? 1) - 1;
        if (count > 0) counts.set(id, count);
        else counts.delete(id);
      }
  }

  check(): void {
    for (const check of [...this.checks]) check();
  }

  /** Resolve true once the graph settled, false when `signal` aborts first. */
  untilSettled(graphId: string, signal?: AbortSignal): Promise<boolean> {
    return this.until(() => {
      const info = this.projection.graphInfo(graphId);
      return info !== undefined && isSettled(info);
    }, signal);
  }

  /** Resolve true once a graph agent's node ended, or at once for others. */
  untilNodeEnded(agentId: string, signal?: AbortSignal): Promise<boolean> {
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
  until(ready: () => boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        this.checks.delete(check);
        signal?.removeEventListener("abort", aborted);
        resolve(value);
      };
      const check = () => {
        if (ready()) done(true);
        else if (this.isClosed()) done(false);
      };
      const aborted = () => done(false);
      this.checks.add(check);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) done(false);
      else check();
    });
  }
}
