/**
 * A cap on the agents that work at once, for model servers that serve one
 * conversation at a time, such as local LLMs that keep one prompt cache.
 * An agent takes a slot at its first model request and keeps it, tool calls
 * included, until its run and its compactions end, so the server's cache
 * stays warm. A follow-up run queues again. Agents over the cap wait in
 * order of arrival. An agent that waits for its helpers gives its slot up
 * meanwhile, so the helpers can work.
 */

import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  GenerationTask,
  type Harness,
  type HookRegistration,
  hook,
  LiveDoc,
  type LiveState,
} from "@earendil-works/pi-durable";
import { readPositiveInteger } from "./settings.js";

/**
 * The cap from Pi's merged settings: `piAgents.maxWorkingAgents`. Absent
 * means no cap; anything but a positive integer is an error, and agents
 * then aren't capped.
 */
export function readWorkingLimit(settings: unknown): {
  limit?: number;
  error?: string;
} {
  const { value, error } = readPositiveInteger(settings, "maxWorkingAgents");
  return error ? { error } : value === undefined ? {} : { limit: value };
}

/** Slots of one harness; agents are keyed by their conversation IDs. */
export class WorkingAgents {
  private readonly holders = new Set<string>();
  /** Agents in order of arrival, with every request that waits for each. */
  private readonly waiting = new Map<string, Set<() => void>>();
  /** Agents waiting for their helpers, with how many waits each has. */
  private readonly paused = new Map<string, number>();
  /** Per agent, the first input of its current run, which names the run. */
  private readonly runs = new Map<string, string>();

  /** Hooks that hold model requests until their agent has a slot. */
  readonly hooks: readonly HookRegistration[];

  constructor(readonly limit: number) {
    this.hooks = [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          await this.acquire(String(api.conversationId), context);
          return undefined;
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, context) => {
          const id = String(api.conversationId);
          // Taking a slot back would keep it from the helpers.
          if (!this.paused.has(id)) await this.acquire(id, context);
          return undefined;
        },
      }),
    ];
  }

  /** Agents that hold a slot. */
  get working(): number {
    return this.holders.size;
  }

  /** Agents that wait for a slot. */
  get queued(): number {
    return this.waiting.size;
  }

  /**
   * Give up the agent's slot while it waits for its helpers, until the
   * returned function is called. Its next request queues again.
   */
  pause(agentId: string): () => void {
    this.paused.set(agentId, (this.paused.get(agentId) ?? 0) + 1);
    this.release(agentId);
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      const count = (this.paused.get(agentId) ?? 1) - 1;
      if (count > 0) this.paused.set(agentId, count);
      else this.paused.delete(agentId);
    };
  }

  /**
   * Release slots as runs and compactions end. Commits arrive in order and
   * before the work they enable, so a release never lands after the next
   * request took the slot. Returns the function that stops observing.
   */
  observe(harness: Harness): () => void {
    return harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (
          change.type === "document" &&
          change.record.kind === LiveDoc.definition.kind &&
          change.conversationId !== undefined
        )
          this.onLive(
            String(change.conversationId),
            change.value as LiveState | null,
          );
    });
  }

  private onLive(agentId: string, live: LiveState | null): void {
    const run = live?.run?.inputs[0];
    const previous = this.runs.get(agentId);
    if (run === undefined) this.runs.delete(agentId);
    else this.runs.set(agentId, String(run));
    const busy = run !== undefined || (live?.compactions?.length ?? 0) > 0;
    // A queued follow-up can replace a run in the commit that ends it.
    const replaced =
      previous !== undefined && run !== undefined && String(run) !== previous;
    if (!busy || replaced) this.release(agentId);
  }

  private acquire(agentId: string, context: Context): Promise<void> {
    if (this.holders.has(agentId)) return Promise.resolve();
    const signal = context.abortSignal;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const waiters = this.waiting.get(agentId);
        waiters?.delete(admit);
        if (waiters?.size === 0) this.waiting.delete(agentId);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // A compaction and a request of one agent share its place in line.
      const waiters = this.waiting.get(agentId) ?? new Set();
      waiters.add(admit);
      this.waiting.set(agentId, waiters);
      this.pump();
    });
  }

  private release(agentId: string): void {
    if (this.holders.delete(agentId)) this.pump();
  }

  private pump(): void {
    for (const [agentId, waiters] of this.waiting) {
      if (this.holders.size >= this.limit) return;
      this.waiting.delete(agentId);
      this.holders.add(agentId);
      for (const admit of waiters) admit();
    }
  }
}
