/**
 * Worker pool for parallel branches and map items: bounded concurrency, early stop
 * once enough successes arrive (any/quorum), fail-fast or collect failure
 * policies, and sibling cancellation via per-task AbortControllers.
 */

import type { CancelReason } from "./events.js";

/** Thrown into (and out of) tasks that were cancelled rather than failed. */
export class CancelledError extends Error {
  readonly reason: CancelReason;

  constructor(reason: CancelReason) {
    super(`cancelled (${reason})`);
    this.name = "CancelledError";
    this.reason = reason;
  }
}

export interface PoolTask<T> {
  key: string;
  run(signal: AbortSignal): Promise<T>;
}

export interface PoolOutcome<T> {
  key: string;
  status: "completed" | "failed" | "cancelled";
  /** Settle sequence number (0 = settled first). Unstarted tasks get -1. */
  order: number;
  /** False when the task was cancelled before it ever ran. */
  started: boolean;
  value?: T;
  error?: unknown;
  cancelReason?: CancelReason;
}

export interface PoolOptions {
  concurrency: number;
  /** Cancel remaining tasks once this many have succeeded. */
  earlyStopAt?: number;
  /** Reason recorded for early-stop cancellations. */
  earlyStopReason?: Extract<CancelReason, "any" | "quorum">;
  /** Cancel remaining tasks as soon as any task fails. */
  failFast: boolean;
  /**
   * Cancel remaining tasks once this many successes become unreachable
   * (collect mode for any/quorum). Omit to always run everything.
   */
  requiredSuccesses?: number;
  signal: AbortSignal;
}

export async function runPool<T>(
  tasks: PoolTask<T>[],
  options: PoolOptions,
): Promise<PoolOutcome<T>[]> {
  const outcomes: PoolOutcome<T>[] = new Array(tasks.length);
  const controllers = new Map<number, AbortController>();
  let next = 0;
  let successes = 0;
  let settledFailures = 0;
  let settleCounter = 0;
  let stopped = false;
  let stopReason: CancelReason = "stopped";

  const stop = (reason: CancelReason): void => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    for (const controller of controllers.values()) {
      controller.abort(new CancelledError(reason));
    }
  };

  const onParentAbort = () => stop("stopped");
  if (options.signal.aborted) {
    stop("stopped");
  } else {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      const task = tasks[index] as PoolTask<T>;
      if (stopped) {
        outcomes[index] = {
          key: task.key,
          status: "cancelled",
          order: -1,
          started: false,
          cancelReason: stopReason,
        };
        continue;
      }
      const controller = new AbortController();
      controllers.set(index, controller);
      try {
        const value = await task.run(controller.signal);
        controllers.delete(index);
        outcomes[index] = {
          key: task.key,
          status: "completed",
          order: settleCounter++,
          started: true,
          value,
        };
        successes += 1;
        if (
          options.earlyStopAt !== undefined &&
          successes >= options.earlyStopAt
        ) {
          stop(options.earlyStopReason ?? "any");
        }
      } catch (error) {
        controllers.delete(index);
        const cancelled =
          controller.signal.aborted || error instanceof CancelledError;
        if (cancelled) {
          const reason =
            error instanceof CancelledError
              ? error.reason
              : controller.signal.reason instanceof CancelledError
                ? controller.signal.reason.reason
                : stopReason;
          outcomes[index] = {
            key: task.key,
            status: "cancelled",
            order: settleCounter++,
            started: true,
            cancelReason: reason,
          };
          continue;
        }
        outcomes[index] = {
          key: task.key,
          status: "failed",
          order: settleCounter++,
          started: true,
          error,
        };
        settledFailures += 1;
        if (options.failFast) {
          stop("sibling_failed");
        } else if (options.requiredSuccesses !== undefined) {
          const unreachable =
            tasks.length - settledFailures < options.requiredSuccesses;
          if (unreachable) stop("sibling_failed");
        }
      }
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  options.signal.removeEventListener("abort", onParentAbort);
  return outcomes;
}
