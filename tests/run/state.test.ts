import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { truncateValue } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import {
  markRunningRunsStopped,
  rebuildRunState,
} from "../../src/run/state.js";

async function recordedEvents(): Promise<RunEvent[]> {
  const flow = validateFlow({
    kind: "seq",
    steps: [
      { kind: "agent", name: "scout", task: "look" },
      {
        kind: "par",
        branches: {
          a: { kind: "agent", name: "x", task: "ta" },
          b: { kind: "agent", name: "x", task: "tb" },
        },
      },
    ],
  });
  const events: RunEvent[] = [];
  await executeFlow({
    runId: "run-42",
    flow,
    label: "test run",
    runAgent: async (call) => ({ text: `out-${call.task}` }),
    emit: (event) => events.push(event),
  });
  return events;
}

describe("run state reducer", () => {
  test("replays a completed run into a coherent view", async () => {
    const events = await recordedEvents();
    const state = rebuildRunState(events);
    expect(state.order).toEqual(["run-42"]);
    const run = state.runs.get("run-42");
    expect(run?.status).toBe("completed");
    expect(run?.header.label).toBe("test run");
    expect(run?.value).toEqual({ a: "out-ta", b: "out-tb" });
    const scout = run?.nodes.get("$.steps[0]");
    expect(scout).toMatchObject({
      kind: "agent",
      agent: "scout",
      status: "completed",
      value: "out-look",
    });
    expect(run?.nodes.get("$.branches.a" as string)).toBeUndefined();
    expect(run?.nodes.get("$.steps[1].branches.a")).toMatchObject({
      status: "completed",
    });
    expect(run?.order[0]).toBe("$");
  });

  test("partial replay leaves the run running; markRunningRunsStopped closes it", async () => {
    const events = await recordedEvents();
    const partial = events.slice(0, events.length - 2);
    const state = rebuildRunState(partial);
    const run = state.runs.get("run-42");
    expect(run?.status).toBe("running");
    markRunningRunsStopped(state);
    expect(run?.status).toBe("stopped");
    expect(run?.error).toContain("restarted");
    for (const node of run?.nodes.values() ?? []) {
      expect(node.status).not.toBe("running");
    }
  });

  test("events for unknown runs are ignored", () => {
    const state = rebuildRunState([
      {
        type: "node_started",
        at: 1,
        runId: "ghost",
        path: "$",
        instance: "$",
        kind: "agent",
      },
    ]);
    expect(state.runs.size).toBe(0);
  });
});

describe("truncateValue", () => {
  test("passes small values through", () => {
    expect(truncateValue({ a: 1 })).toEqual({ a: 1 });
  });

  test("replaces oversized values with a marked string", () => {
    const big = "y".repeat(20_000);
    const result = truncateValue(big) as string;
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain("truncated");
  });
});
