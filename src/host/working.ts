/**
 * A cap on the agents that work at once, for model servers that serve one
 * conversation at a time, such as local LLMs that keep one prompt cache.
 * An agent takes a slot at its first model request and keeps it, tool calls
 * included, until its run and its compactions end, so the server's cache
 * stays warm. A follow-up run queues again. Agents over the cap wait in
 * order of arrival. An agent that waits for its helpers gives its slot up
 * meanwhile, so the helpers can work.
 *
 * Slots are taken in the hooks before generation requests and before
 * compactions summarize. A compaction that a restart resumes mid-summary
 * passes no hook and runs without a slot.
 */

import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  GenerationTask,
  type Harness,
  type HookApi,
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

/** What the cap knows of an agent from its `LiveDoc`. */
interface Live {
  /** The first input of its current run, which names the run. */
  run?: string;
  /** Whether a compaction of it runs or waits for a slot. */
  compacting: boolean;
}

/** Slots of one harness; agents are keyed by their conversation IDs. */
export class WorkingAgents {
  private readonly holders = new Set<string>();
  /** Agents in order of arrival, with every request that waits for each. */
  private readonly waiting = new Map<string, Set<() => void>>();
  /** Agents waiting for their helpers, with how many waits each has. */
  private readonly paused = new Map<string, number>();
  private readonly live = new Map<string, Live>();

  /** Hooks that hold model requests until their agent has a slot. */
  readonly hooks: readonly HookRegistration[];

  constructor(readonly limit: number) {
    const acquire = async (api: HookApi, context: Context) => {
      await this.acquire(String(api.conversationId), context);
      return undefined;
    };
    this.hooks = [
      hook(GenerationTask, {
        beforeRequest: (_request, api, context) => acquire(api, context),
      }),
      hook(CompactionTask, {
        beforeCompact: (_compaction, api, context) => acquire(api, context),
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
   * returned function is called: once its compactions end, and without
   * taking it back meanwhile. Its next request queues again.
   */
  pause(agentId: string): () => void {
    this.paused.set(agentId, (this.paused.get(agentId) ?? 0) + 1);
    this.settle(agentId);
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      const count = (this.paused.get(agentId) ?? 1) - 1;
      if (count > 0) this.paused.set(agentId, count);
      else this.paused.delete(agentId);
      this.pump();
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

  private onLive(agentId: string, state: LiveState | null): void {
    const first = state?.run?.inputs[0];
    const run = first === undefined ? undefined : String(first);
    const previous = this.live.get(agentId)?.run;
    const compacting = (state?.compactions?.length ?? 0) > 0;
    if (run === undefined && !compacting) this.live.delete(agentId);
    else
      this.live.set(agentId, {
        ...(run === undefined ? {} : { run }),
        compacting,
      });
    // A queued follow-up can replace a run in the commit that ends it; it
    // queues again, unless a compaction keeps the slot and the follow-up
    // with it.
    const replaced =
      previous !== undefined && run !== undefined && run !== previous;
    this.settle(agentId, replaced);
  }

  /** Release the agent's slot unless its run or compactions still use it. */
  private settle(agentId: string, replaced = false): void {
    if (!this.holders.has(agentId)) return;
    const live = this.live.get(agentId);
    if (live?.compacting) return;
    if (live?.run !== undefined && !replaced && !this.paused.has(agentId))
      return;
    this.holders.delete(agentId);
    this.pump();
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

  /** Admit waiting agents in order; paused ones keep their place. */
  private pump(): void {
    for (const [agentId, waiters] of this.waiting) {
      if (this.holders.size >= this.limit) return;
      if (this.paused.has(agentId)) continue;
      this.waiting.delete(agentId);
      this.holders.add(agentId);
      for (const admit of waiters) admit();
    }
  }
}
