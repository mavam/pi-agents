import { describe, expect, test } from "bun:test";
import { emptyUsage } from "../../src/engine/types.js";
import type { FlowNode, WorkflowLike } from "../../src/model/ast.js";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import {
  type AgentCall,
  type AgentRunner,
  type ExecuteOptions,
  executeFlow,
  parseJsonOutput,
} from "../../src/run/interpreter.js";

const agent = (
  name: string,
  task: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "agent",
  name,
  task,
  ...extra,
});
const seq = (...steps: unknown[]) => ({ kind: "seq", steps });

type Handler = (call: AgentCall) => string | Promise<string>;

function makeRunner(handler: Handler): {
  runner: AgentRunner;
  calls: AgentCall[];
} {
  const calls: AgentCall[] = [];
  return {
    calls,
    runner: async (call) => {
      calls.push(call);
      const text = await handler(call);
      const usage = emptyUsage();
      usage.turns = 1;
      usage.cost = 0.01;
      return { text, usage };
    },
  };
}

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function run(
  raw: unknown,
  handler: Handler,
  overrides: Partial<ExecuteOptions> = {},
  resolveWorkflow?: (name: string) => WorkflowLike | undefined,
) {
  const flow = validateFlow(raw, {
    resolveWorkflow,
    params: overrides.params ? paramDefsOf(overrides.params) : undefined,
  });
  const { runner, calls } = makeRunner(handler);
  const events: RunEvent[] = [];
  const outcome = await executeFlow({
    runId: "run-1",
    flow,
    runAgent: runner,
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { outcome, calls, events };
}

function paramDefsOf(params: Record<string, unknown>) {
  return Object.keys(params).map((name) => ({ name }));
}

function eventTypes(events: RunEvent[], type: RunEvent["type"]): RunEvent[] {
  return events.filter((event) => event.type === type);
}

describe("seq and bindings", () => {
  test("threads {previous} and named bindings into tasks", async () => {
    const { outcome, calls } = await run(
      seq(
        agent("scout", "map the code", { as: "map" }),
        agent("planner", "plan using {map}"),
        agent("worker", "implement {previous} against {map}"),
      ),
      (call) => `${call.agent}-result`,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toBe("worker-result");
    expect(calls.map((call) => call.task)).toEqual([
      "map the code",
      "plan using scout-result",
      "implement planner-result against scout-result",
    ]);
  });

  test("dot paths reach into JSON outputs", async () => {
    const { calls } = await run(
      seq(
        agent("scout", "list", { as: "scout", output: "json" }),
        agent("worker", "fix {scout.files.0}"),
      ),
      (call) =>
        call.agent === "scout" ? '{"files": ["a.ts", "b.ts"]}' : "done",
    );
    expect(calls[1]?.task).toBe("fix a.ts");
  });

  test("json output tolerates fences and fails loudly otherwise", async () => {
    expect(parseJsonOutput('```json\n{"ok": true}\n```')).toEqual({ ok: true });
    expect(parseJsonOutput("[1, 2]")).toEqual([1, 2]);
    const { outcome, events } = await run(
      agent("a", "t", { output: "json" }),
      () => "not json at all",
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("expected JSON output");
    expect(eventTypes(events, "node_failed")).toHaveLength(1);
  });
});

describe("par", () => {
  test("mode all collects branch values by name", async () => {
    const { outcome } = await run(
      {
        kind: "par",
        branches: {
          bugs: agent("r", "find bugs"),
          style: agent("r", "check style"),
        },
      },
      (call) => `did: ${call.task}`,
    );
    expect(outcome.value).toEqual({
      bugs: "did: find bugs",
      style: "did: check style",
    });
  });

  test("mode any yields the winner and cancels the loser", async () => {
    const { outcome, events } = await run(
      {
        kind: "par",
        mode: "any",
        branches: {
          fast: agent("f", "quick"),
          slow: agent("s", "slow"),
        },
      },
      (call) =>
        call.agent === "f" ? "fast-wins" : hangUntilAbort(call.signal),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toBe("fast-wins");
    const cancelled = eventTypes(events, "node_cancelled");
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    expect(
      cancelled.map((e) => (e as { instance: string }).instance),
    ).toContain("$.branches.slow");
    expect((cancelled[0] as { reason: string }).reason).toBe("any");
  });

  test("quorum collects the first n successes", async () => {
    const { outcome } = await run(
      {
        kind: "par",
        mode: { quorum: 2 },
        branches: {
          a: agent("x", "ta"),
          b: agent("x", "tb"),
          c: agent("x", "tc"),
        },
        concurrency: 2,
      },
      (call) =>
        call.task === "tc" ? hangUntilAbort(call.signal) : `ok-${call.task}`,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ a: "ok-ta", b: "ok-tb" });
  });

  test("fail-fast cancels siblings and fails the par", async () => {
    const { outcome, events } = await run(
      {
        kind: "par",
        branches: {
          bad: agent("b", "explode"),
          slow: agent("s", "slow"),
        },
      },
      (call) => {
        if (call.agent === "b") throw new Error("boom");
        return hangUntilAbort(call.signal);
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("branch 'bad' failed: boom");
    const cancelled = eventTypes(events, "node_cancelled");
    expect(cancelled.map((e) => (e as { reason: string }).reason)).toContain(
      "sibling_failed",
    );
  });

  test("collect mode gathers errors alongside successes", async () => {
    const { outcome } = await run(
      {
        kind: "par",
        onError: "collect",
        branches: { good: agent("g", "ok"), bad: agent("b", "explode") },
      },
      (call) => {
        if (call.agent === "b") throw new Error("boom");
        return "fine";
      },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ good: "fine", bad: { error: "boom" } });
  });

  test("collect mode fails when every branch fails", async () => {
    const { outcome } = await run(
      {
        kind: "par",
        onError: "collect",
        branches: { a: agent("x", "ta"), b: agent("x", "tb") },
      },
      () => {
        throw new Error("nope");
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("got 0");
  });

  test("reduce folds branches through a reducer agent", async () => {
    const { outcome, calls, events } = await run(
      {
        kind: "par",
        branches: { a: agent("x", "ta"), b: agent("x", "tb") },
        reduce: { agent: "syn", task: "merge {branches}" },
      },
      (call) => (call.agent === "syn" ? "merged!" : `v-${call.task}`),
    );
    expect(outcome.value).toBe("merged!");
    const reduceCall = calls.find((call) => call.agent === "syn");
    expect(reduceCall?.task).toContain('"a": "v-ta"');
    expect(reduceCall?.path).toBe("$.reduce");
    const started = eventTypes(events, "node_started").find(
      (e) => (e as { kind: string }).kind === "reduce",
    );
    expect(started).toBeDefined();
  });
});

describe("map", () => {
  test("fans out per item, preserving input order", async () => {
    const { outcome, calls } = await run(
      seq(agent("scout", "list files", { as: "files", output: "json" }), {
        kind: "map",
        over: "{files}",
        body: agent("reviewer", "review {item} at {index}"),
      }),
      (call) => {
        if (call.agent === "scout") return '["a.ts", "b.ts", "c.ts"]';
        return `reviewed ${call.task.split(" ")[1]}`;
      },
    );
    expect(outcome.value).toEqual([
      "reviewed a.ts",
      "reviewed b.ts",
      "reviewed c.ts",
    ]);
    const reviewTasks = calls
      .filter((call) => call.agent === "reviewer")
      .map((call) => call.task);
    expect(reviewTasks).toEqual([
      "review a.ts at 0",
      "review b.ts at 1",
      "review c.ts at 2",
    ]);
  });

  test("map body instances carry @index suffixes", async () => {
    const { events } = await run(
      seq(agent("s", "list", { as: "files", output: "json" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
      }),
      (call) => (call.agent === "s" ? '["x", "y"]' : "ok"),
    );
    const instances = eventTypes(events, "node_started").map(
      (e) => (e as { instance: string }).instance,
    );
    expect(instances).toContain("$.steps[1].body@0");
    expect(instances).toContain("$.steps[1].body@1");
  });

  test("non-array over fails the node", async () => {
    const { outcome } = await run(
      seq(agent("s", "list", { as: "files", output: "json" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
      }),
      (call) => (call.agent === "s" ? '{"not": "array"}' : "ok"),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("must resolve to a JSON array, got object");
  });

  test("item failure fails the map and cancels siblings", async () => {
    const { outcome } = await run(
      seq(agent("s", "list", { as: "files", output: "json" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
        concurrency: 2,
      }),
      (call) => {
        if (call.agent === "s") return '["a", "b"]';
        if (call.task === "review a") throw new Error("bad item");
        return hangUntilAbort(call.signal);
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("item 0 failed: bad item");
  });

  test("reduce sees {items}", async () => {
    const { calls, outcome } = await run(
      seq(agent("s", "list", { as: "files", output: "json" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
        reduce: { agent: "syn", task: "combine {items}" },
      }),
      (call) => {
        if (call.agent === "s") return '["a"]';
        if (call.agent === "syn") return "combined";
        return "r-a";
      },
    );
    expect(outcome.value).toBe("combined");
    expect(calls.find((call) => call.agent === "syn")?.task).toContain("r-a");
  });
});

describe("loop", () => {
  test("iterates with {iteration} and {last}, stopping on until", async () => {
    let round = 0;
    const { outcome, calls, events } = await run(
      {
        kind: "loop",
        body: agent("worker", "round {iteration}, prior: [{last}]", {
          output: "json",
        }),
        max: 5,
        until: { eq: ["done", true] },
      },
      () => {
        round += 1;
        return round >= 3
          ? '{"done": true, "round": 3}'
          : `{"done": false, "round": ${round}}`;
      },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ done: true, round: 3 });
    expect(calls[0]?.task).toBe("round 0, prior: []");
    expect(calls[1]?.task).toContain('"round": 1');
    expect(eventTypes(events, "loop_iteration")).toHaveLength(3);
    const instances = eventTypes(events, "node_started").map(
      (e) => (e as { instance: string }).instance,
    );
    expect(instances).toContain("$.body#0");
    expect(instances).toContain("$.body#2");
  });

  test("max caps iterations when until never holds", async () => {
    const { calls } = await run(
      {
        kind: "loop",
        body: agent("w", "go"),
        max: 2,
        until: { eq: ["", "never"] },
      },
      () => "output",
    );
    expect(calls).toHaveLength(2);
  });

  test("budget maxIterations caps below max", async () => {
    const { calls } = await run(
      { kind: "loop", body: agent("w", "go"), max: 9 },
      () => "output",
      { budgets: { maxIterations: 3 } },
    );
    expect(calls).toHaveLength(3);
  });
});

describe("workflow refs", () => {
  const reviewDef: WorkflowLike = {
    name: "review",
    params: [
      { name: "target", required: true },
      { name: "depth", default: "shallow" },
    ],
    flow: {
      kind: "agent",
      name: "reviewer",
      task: "review {params.target} at {params.depth}",
    } as FlowNode,
  };

  test("params interpolate in the caller scope; defaults apply", async () => {
    const { calls, outcome } = await run(
      seq(agent("scout", "find target", { as: "spot" }), {
        kind: "workflow",
        name: "review",
        params: { target: "{spot}" },
      }),
      (call) => (call.agent === "scout" ? "src/core" : "review-done"),
      {},
      (name) => (name === "review" ? reviewDef : undefined),
    );
    expect(outcome.value).toBe("review-done");
    expect(calls[1]?.task).toBe("review src/core at shallow");
  });

  test("inlined body runs at .body paths", async () => {
    const { events } = await run(
      { kind: "workflow", name: "review", params: { target: "x" } },
      () => "ok",
      {},
      (name) => (name === "review" ? reviewDef : undefined),
    );
    const instances = eventTypes(events, "node_started").map(
      (e) => (e as { instance: string }).instance,
    );
    expect(instances).toEqual(["$", "$.body"]);
  });
});

describe("budgets and aborts", () => {
  test("maxAgents budget fails the run", async () => {
    const { outcome } = await run(
      seq(agent("a", "1"), agent("a", "2"), agent("a", "3")),
      () => "ok",
      { budgets: { maxAgents: 2 } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("agent budget exceeded (maxAgents: 2)");
  });

  test("maxDepth rejects runs spawned too deep", async () => {
    const { outcome } = await run(agent("a", "t"), () => "ok", {
      depth: 5,
      budgets: { maxDepth: 3 },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("depth budget exceeded");
  });

  test("external abort stops the run and cancels nodes", async () => {
    const controller = new AbortController();
    const promise = run(
      agent("a", "t"),
      (call) => {
        queueMicrotask(() => controller.abort());
        return hangUntilAbort(call.signal);
      },
      { signal: controller.signal },
    );
    const { outcome, events } = await promise;
    expect(outcome.status).toBe("stopped");
    expect(eventTypes(events, "node_cancelled").length).toBeGreaterThanOrEqual(
      1,
    );
    const completed = eventTypes(events, "run_completed")[0] as {
      status: string;
    };
    expect(completed.status).toBe("stopped");
  });

  test("usage aggregates across agents", async () => {
    const { outcome } = await run(
      seq(agent("a", "1"), agent("a", "2")),
      () => "ok",
    );
    expect(outcome.usage.turns).toBe(2);
    expect(outcome.usage.cost).toBeCloseTo(0.02);
    expect(outcome.agents).toBe(2);
  });
});

describe("event stream shape", () => {
  test("run_created carries the expanded flow; events address nodes by path", async () => {
    const { events } = await run(
      seq(agent("a", "1"), agent("b", "2")),
      () => "ok",
    );
    const created = events[0] as {
      type: string;
      run: { flow: FlowNode; id: string };
    };
    expect(created.type).toBe("run_created");
    expect(created.run.flow.kind).toBe("seq");
    const started = eventTypes(events, "node_started").map(
      (e) => (e as { path: string }).path,
    );
    expect(started).toEqual(["$", "$.steps[0]", "$.steps[1]"]);
    const last = events[events.length - 1] as { type: string; status: string };
    expect(last.type).toBe("run_completed");
    expect(last.status).toBe("completed");
  });
});
