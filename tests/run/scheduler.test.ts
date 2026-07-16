import { describe, expect, test } from "bun:test";
import {
  CancelledError,
  type PoolTask,
  runPool,
} from "../../src/run/scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortable(
  signal: AbortSignal,
  work: Promise<string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
    work.then(resolve, reject);
  });
}

const never = new AbortController().signal;

describe("runPool", () => {
  test("respects the concurrency cap", async () => {
    let running = 0;
    let peak = 0;
    const tasks: PoolTask<string>[] = Array.from({ length: 6 }, (_, i) => ({
      key: String(i),
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return `done-${i}`;
      },
    }));
    const outcomes = await runPool(tasks, {
      concurrency: 2,
      failFast: true,
      signal: never,
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
  });

  test("early stop cancels running tasks and skips unstarted ones", async () => {
    const gate = deferred<string>();
    const tasks: PoolTask<string>[] = [
      { key: "winner", run: async () => "first" },
      { key: "running", run: (signal) => abortable(signal, gate.promise) },
      { key: "queued", run: async () => "never-starts" },
    ];
    const outcomes = await runPool(tasks, {
      concurrency: 2,
      earlyStopAt: 1,
      earlyStopReason: "any",
      failFast: true,
      signal: never,
    });
    expect(outcomes[0]).toMatchObject({
      key: "winner",
      status: "completed",
      value: "first",
    });
    expect(outcomes[1]).toMatchObject({
      key: "running",
      status: "cancelled",
      cancelReason: "any",
      started: true,
    });
    expect(outcomes[2]).toMatchObject({
      key: "queued",
      status: "cancelled",
      started: false,
    });
  });

  test("collect mode stops once required successes become unreachable", async () => {
    const gate = deferred<string>();
    const tasks: PoolTask<string>[] = [
      {
        key: "a",
        run: async () => {
          throw new Error("a failed");
        },
      },
      {
        key: "b",
        run: async () => {
          throw new Error("b failed");
        },
      },
      { key: "c", run: (signal) => abortable(signal, gate.promise) },
    ];
    // Quorum of 2 over 3 tasks: after 2 failures only 1 can succeed → stop.
    const outcomes = await runPool(tasks, {
      concurrency: 2,
      failFast: false,
      requiredSuccesses: 2,
      signal: never,
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[1]?.status).toBe("failed");
    expect(outcomes[2]?.status).toBe("cancelled");
  });

  test("without failFast or thresholds, everything runs", async () => {
    const tasks: PoolTask<string>[] = [
      {
        key: "bad",
        run: async () => {
          throw new Error("nope");
        },
      },
      { key: "good", run: async () => "fine" },
    ];
    const outcomes = await runPool(tasks, {
      concurrency: 1,
      failFast: false,
      signal: never,
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[1]).toMatchObject({ status: "completed", value: "fine" });
  });

  test("pre-aborted parent signal cancels everything unstarted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcomes = await runPool([{ key: "x", run: async () => "value" }], {
      concurrency: 1,
      failFast: true,
      signal: controller.signal,
    });
    expect(outcomes[0]).toMatchObject({
      status: "cancelled",
      started: false,
      cancelReason: "stopped",
    });
  });

  test("settle order is recorded", async () => {
    const first = deferred<string>();
    const tasks: PoolTask<string>[] = [
      { key: "slow", run: (signal) => abortable(signal, first.promise) },
      { key: "fast", run: async () => "quick" },
    ];
    const pool = runPool(tasks, {
      concurrency: 2,
      failFast: true,
      signal: never,
    });
    setTimeout(() => first.resolve("slow-done"), 5);
    const outcomes = await pool;
    const fast = outcomes.find((o) => o.key === "fast");
    const slow = outcomes.find((o) => o.key === "slow");
    expect(fast && slow && fast.order < slow.order).toBe(true);
  });

  test("CancelledError carries its reason", () => {
    expect(new CancelledError("quorum").reason).toBe("quorum");
  });
});
