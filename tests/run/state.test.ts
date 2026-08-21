import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import {
  markRunningRunsStopped,
  rebuildRunState,
} from "../../src/run/state.js";

async function recordedEvents(): Promise<RunEvent[]> {
  const flow = validateFlow({
    kind: "sequence",
    steps: [
      { kind: "agent", name: "scout", task: "look" },
      {
        kind: "parallel",
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
    display: "report",
    runAgent: async (call) => ({ value: `out-${call.task}` }),
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
    expect(run?.header.display).toBe("report");
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

  test("replays node session files onto their node", async () => {
    const events = await recordedEvents();
    const startedIndex = events.findIndex(
      (event) =>
        event.type === "node_started" && event.instance === "$.steps[0]",
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    events.splice(startedIndex + 1, 0, {
      type: "node_session",
      at: 2,
      runId: "run-42",
      path: "$.steps[0]",
      instance: "$.steps[0]",
      sessionFile: "/tmp/agent-session.jsonl",
    });

    expect(
      rebuildRunState(events).runs.get("run-42")?.nodes.get("$.steps[0]")
        ?.sessionFile,
    ).toBe("/tmp/agent-session.jsonl");
  });
});

describe("budget events", () => {
  test("node_failed preserves partialText; budget cancellations replay", () => {
    const events: RunEvent[] = [
      {
        type: "run_created",
        at: 1,
        run: {
          id: "run-b",
          source: { kind: "tool" },
          flow: {
            kind: "parallel",
            branches: {
              a: { kind: "agent", task: "ta" },
              b: { kind: "agent", task: "tb" },
            },
          },
          depth: 0,
        },
      },
      {
        type: "node_started",
        at: 2,
        runId: "run-b",
        path: "$.branches.a",
        instance: "$.branches.a",
        kind: "agent",
      },
      {
        type: "node_started",
        at: 2,
        runId: "run-b",
        path: "$.branches.b",
        instance: "$.branches.b",
        kind: "agent",
      },
      {
        type: "node_failed",
        at: 3,
        runId: "run-b",
        path: "$.branches.a",
        instance: "$.branches.a",
        error: "agent turn budget exceeded (maxTurns: 2)",
        partialText: "half an answer",
      },
      {
        type: "node_cancelled",
        at: 3,
        runId: "run-b",
        path: "$.branches.b",
        instance: "$.branches.b",
        reason: "budget",
      },
      {
        type: "run_completed",
        at: 4,
        runId: "run-b",
        status: "failed",
        error: "run duration budget exceeded (maxDuration: 600s)",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        agents: 2,
      },
    ];
    const state = rebuildRunState(events);
    const run = state.runs.get("run-b");
    expect(run?.status).toBe("failed");
    expect(run?.nodes.get("$.branches.a")).toMatchObject({
      status: "failed",
      partialText: "half an answer",
    });
    expect(run?.nodes.get("$.branches.b")).toMatchObject({
      status: "cancelled",
      cancelReason: "budget",
    });
  });
});
