import { describe, expect, test } from "bun:test";
import { AgentErrorResult, emptyUsage } from "../../src/engine/types.js";
import type { FlowNode, WorkflowLike } from "../../src/model/ast.js";
import { validateFlow } from "../../src/model/validate.js";
import { BudgetExceededError } from "../../src/run/budgets.js";
import type { RunEvent } from "../../src/run/events.js";
import {
  type AgentCall,
  type AgentRunner,
  type ExecuteOptions,
  executeFlow,
} from "../../src/run/interpreter.js";

const agent = (
  profile: string,
  task: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "agent",
  profile,
  task,
  ...extra,
});
const seq = (...steps: unknown[]) => ({ kind: "sequence", steps });

type Handler = (call: AgentCall) => unknown | Promise<unknown>;

function makeRunner(handler: Handler): {
  runner: AgentRunner;
  calls: AgentCall[];
} {
  const calls: AgentCall[] = [];
  return {
    calls,
    runner: async (call) => {
      calls.push(call);
      const value = await handler(call);
      const usage = emptyUsage();
      usage.turns = 1;
      usage.cost = 0.01;
      return { value, usage };
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

describe("model identity events", () => {
  test("emits planned identity for agents and reduces and deduplicates effective changes", async () => {
    const { events } = await run(
      {
        kind: "parallel",
        branches: {
          one: {
            kind: "agent",
            task: "work",
            model: "gpt-5",
            thinking: "high",
          },
        },
        reduce: { task: "merge {branches}", model: "opus" },
      },
      (call) => {
        call.onProgress?.({
          text: "first",
          usage: emptyUsage(),
          model: "openai/gpt-5",
        });
        call.onProgress?.({
          text: "same",
          usage: emptyUsage(),
          model: "openai/gpt-5",
        });
        call.onProgress?.({
          text: "fallback",
          usage: emptyUsage(),
          model: "openai/gpt-5-fallback",
        });
        return "ok";
      },
      {
        resolvePlannedModel: (call) => ({
          model:
            call.model === "opus" ? "anthropic/claude-opus" : "openai/gpt-5",
          requestedModel: call.model,
          thinking: call.thinking,
        }),
      },
    );

    const started = eventTypes(events, "node_started");
    expect(
      started.find(
        (event) => event.type === "node_started" && event.kind === "agent",
      ),
    ).toMatchObject({
      model: "openai/gpt-5",
      requestedModel: "gpt-5",
      thinking: "high",
    });
    expect(
      started.find(
        (event) => event.type === "node_started" && event.kind === "reduce",
      ),
    ).toMatchObject({
      model: "anthropic/claude-opus",
      requestedModel: "opus",
    });
    const observed = eventTypes(events, "node_model").filter(
      (event) =>
        event.type === "node_model" &&
        event.instance.endsWith(".reduce") === false,
    );
    expect(
      observed.map((event) =>
        event.type === "node_model" ? event.model : undefined,
      ),
    ).toEqual(["openai/gpt-5", "openai/gpt-5-fallback"]);
  });
});

describe("seq and bindings", () => {
  test("threads {previous} and named bindings into tasks", async () => {
    const { outcome, calls } = await run(
      seq(
        agent("scout", "map the code", { as: "map" }),
        agent("planner", "plan using {map}"),
        agent("worker", "implement {previous} against {map}"),
      ),
      (call) => `${call.profile}-result`,
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
        agent("scout", "list", {
          as: "scout",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        agent("worker", "fix {scout.files.0}"),
      ),
      (call) =>
        call.profile === "scout" ? { files: ["a.ts", "b.ts"] } : "done",
    );
    expect(calls[1]?.task).toBe("fix a.ts");
    expect(calls[0]?.resultSchema).toMatchObject({ type: expect.anything() });
  });

  test("submitted JSON values pass through without text parsing", async () => {
    const submitted = { ok: true, nested: [1, null, "two"] };
    const { outcome } = await run(
      agent("a", "t", {
        json: {
          type: ["null", "boolean", "number", "string", "array", "object"],
        },
      }),
      () => submitted,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toBe(submitted);
  });
});

describe("execution option forwarding", () => {
  const options = {
    model: "m",
    thinking: "low",
    skills: ["code-review"],
    tools: ["read"],
    cwd: "/elsewhere",
    scope: "user",
  } as const;

  test("agent nodes forward every option to the call", async () => {
    const { calls } = await run(
      { kind: "agent", task: "t", ...options },
      () => "ok",
      { cwd: "/run", scope: "both" },
    );
    expect(calls[0]).toMatchObject(options);
  });

  test("reducers forward every option to the call", async () => {
    const { calls } = await run(
      {
        kind: "parallel",
        branches: { a: { kind: "agent", task: "a" } },
        reduce: { task: "merge {branches}", profile: "synth", ...options },
      },
      () => "ok",
      { cwd: "/run", scope: "both" },
    );
    expect(calls.at(-1)).toMatchObject({ profile: "synth", ...options });
  });

  test("a reducer without overrides inherits the run's cwd and scope", async () => {
    const { calls } = await run(
      {
        kind: "map",
        over: "{params.files}",
        body: { kind: "agent", task: "review {item}" },
        reduce: { task: "merge {items}" },
      },
      () => "ok",
      { cwd: "/run", scope: "project", params: { files: ["a"] } },
    );
    expect(calls.at(-1)).toMatchObject({ cwd: "/run", scope: "project" });
    expect(calls.at(-1)?.skills).toBeUndefined();
    expect(calls.at(-1)?.tools).toBeUndefined();
  });
});

describe("parallel", () => {
  test("mode all collects branch values by name", async () => {
    const { outcome } = await run(
      {
        kind: "parallel",
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
        kind: "parallel",
        mode: "any",
        branches: {
          fast: agent("f", "quick"),
          slow: agent("s", "slow"),
        },
      },
      (call) =>
        call.profile === "f" ? "fast-wins" : hangUntilAbort(call.signal),
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
        kind: "parallel",
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
        kind: "parallel",
        branches: {
          bad: agent("b", "explode"),
          slow: agent("s", "slow"),
        },
      },
      (call) => {
        if (call.profile === "b") throw new Error("boom");
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
        kind: "parallel",
        onError: "collect",
        branches: { good: agent("g", "ok"), bad: agent("b", "explode") },
      },
      (call) => {
        if (call.profile === "b") throw new Error("boom");
        return "fine";
      },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ good: "fine", bad: { error: "boom" } });
  });

  test("collect mode preserves an agent-submitted error reason", async () => {
    const { outcome, events } = await run(
      {
        kind: "parallel",
        onError: "collect",
        branches: { good: agent("g", "ok"), bad: agent("b", "blocked") },
      },
      (call) => {
        if (call.profile === "b") {
          throw new AgentErrorResult("b", "required context is unavailable");
        }
        return "fine";
      },
    );
    expect(outcome.value).toEqual({
      good: "fine",
      bad: { error: "required context is unavailable" },
    });
    expect(
      events.find(
        (event) =>
          event.type === "node_failed" && event.instance === "$.branches.bad",
      ),
    ).toMatchObject({ error: "required context is unavailable" });
  });

  test("an agent-submitted error fails the run with its reason", async () => {
    const { outcome, events } = await run(agent("a", "blocked"), () => {
      throw new AgentErrorResult("a", "the target cannot be inspected");
    });
    expect(outcome).toMatchObject({
      status: "failed",
      error: "the target cannot be inspected",
    });
    expect(events.find((event) => event.type === "node_failed")).toMatchObject({
      error: "the target cannot be inspected",
    });
  });

  test("collect mode fails when every branch fails", async () => {
    const { outcome } = await run(
      {
        kind: "parallel",
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
        kind: "parallel",
        branches: { a: agent("x", "ta"), b: agent("x", "tb") },
        reduce: { profile: "syn", task: "merge {branches}" },
      },
      (call) => (call.profile === "syn" ? "merged!" : `v-${call.task}`),
    );
    expect(outcome.value).toBe("merged!");
    const reduceCall = calls.find((call) => call.profile === "syn");
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
      seq(
        agent("scout", "list files", {
          as: "files",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{files}",
          body: agent("reviewer", "review {item} at {index}"),
        },
      ),
      (call) => {
        if (call.profile === "scout") return ["a.ts", "b.ts", "c.ts"];
        return `reviewed ${call.task.split(" ")[1]}`;
      },
    );
    expect(outcome.value).toEqual([
      "reviewed a.ts",
      "reviewed b.ts",
      "reviewed c.ts",
    ]);
    const reviewTasks = calls
      .filter((call) => call.profile === "reviewer")
      .map((call) => call.task);
    expect(reviewTasks).toEqual([
      "review a.ts at 0",
      "review b.ts at 1",
      "review c.ts at 2",
    ]);
  });

  test("map body instances carry @index suffixes", async () => {
    const { events } = await run(
      seq(
        agent("s", "list", {
          as: "files",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{files}",
          body: agent("r", "review {item}"),
        },
      ),
      (call) => (call.profile === "s" ? ["x", "y"] : "ok"),
    );
    const instances = eventTypes(events, "node_started").map(
      (e) => (e as { instance: string }).instance,
    );
    expect(instances).toContain("$.steps[1].body@0");
    expect(instances).toContain("$.steps[1].body@1");
  });

  test("non-array over fails the node", async () => {
    const { outcome } = await run(
      seq(
        agent("s", "list", {
          as: "files",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{files}",
          body: agent("r", "review {item}"),
        },
      ),
      (call) => (call.profile === "s" ? { not: "array" } : "ok"),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("must resolve to a JSON array, got object");
  });

  test("item failure fails the map and cancels siblings", async () => {
    const { outcome } = await run(
      seq(
        agent("s", "list", {
          as: "files",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{files}",
          body: agent("r", "review {item}"),
          concurrency: 2,
        },
      ),
      (call) => {
        if (call.profile === "s") return ["a", "b"];
        if (call.task === "review a") throw new Error("bad item");
        return hangUntilAbort(call.signal);
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("item 0 failed: bad item");
  });

  test("reduce sees {items}", async () => {
    const { calls, outcome } = await run(
      seq(
        agent("s", "list", {
          as: "files",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{files}",
          body: agent("r", "review {item}"),
          reduce: { profile: "syn", task: "combine {items}" },
        },
      ),
      (call) => {
        if (call.profile === "s") return ["a"];
        if (call.profile === "syn") return "combined";
        return "r-a";
      },
    );
    expect(outcome.value).toBe("combined");
    expect(calls.find((call) => call.profile === "syn")?.task).toContain("r-a");
  });
});

describe("loop", () => {
  test("iterates with {iteration} and {last}, stopping on until", async () => {
    let round = 0;
    const { outcome, calls, events } = await run(
      {
        kind: "loop",
        body: agent("worker", "round {iteration}, prior: [{last}]", {
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        max: 5,
        until: { eq: ["done", true] },
      },
      () => {
        round += 1;
        return { done: round >= 3, round };
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

describe("while", () => {
  test("returns the initial value when the condition is false", async () => {
    const { outcome, calls, events } = await run(
      seq(
        agent("seed", "state", {
          as: "state",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["continue", true] },
          max: 3,
          body: agent("worker", "use {current}", {
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
          }),
        },
      ),
      (call) =>
        call.profile === "seed"
          ? { continue: false, round: null }
          : { continue: false, round: 0 },
    );
    expect(outcome.value).toEqual({ continue: false, round: null });
    expect(calls.map((call) => call.profile)).toEqual(["seed"]);
    expect(eventTypes(events, "loop_iteration")).toHaveLength(0);
  });

  test("carries body values through {current} until the condition is false", async () => {
    let round = 0;
    const { outcome, calls, events } = await run(
      seq(
        agent("seed", "state", {
          as: "state",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["continue", true] },
          max: 5,
          body: agent("worker", "round {iteration}, current: {current}", {
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
          }),
        },
      ),
      (call) => {
        if (call.profile === "seed") return { continue: true, round: -1 };
        round += 1;
        return { continue: round < 3, round: round - 1 };
      },
    );
    expect(outcome.value).toEqual({ continue: false, round: 2 });
    expect(calls[1]?.task).toContain("round 0");
    expect(calls[1]?.task).toContain('"round": -1');
    expect(calls[2]?.task).toContain('"round": 0');
    expect(eventTypes(events, "loop_iteration")).toHaveLength(3);
    const instances = eventTypes(events, "node_started").map(
      (event) => (event as { instance: string }).instance,
    );
    expect(instances).toContain("$.steps[1].body#0");
    expect(instances).toContain("$.steps[1].body#2");
  });

  test("returns a still-matching value when the effective cap is reached", async () => {
    const { outcome, calls } = await run(
      seq(
        agent("seed", "state", {
          as: "state",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["continue", true] },
          max: 9,
          body: agent("worker", "round {iteration}", {
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
          }),
        },
      ),
      (call) =>
        call.profile === "seed"
          ? { continue: true, round: -1 }
          : { continue: true, round: 0 },
      { budgets: { maxIterations: 2 } },
    );
    expect(outcome.value).toEqual({ continue: true, round: 0 });
    expect(calls.filter((call) => call.profile === "worker")).toHaveLength(2);
  });

  test("an inner on resolves outer {current} before its body shadows it", async () => {
    const { outcome, calls } = await run(
      seq(
        agent("seed", "state", {
          as: "state",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["outer", true] },
          max: 1,
          body: {
            kind: "while",
            on: "{current}",
            condition: { eq: ["inner", true] },
            max: 1,
            body: agent("worker", "inner {iteration}: {current}", {
              json: {
                type: [
                  "null",
                  "boolean",
                  "number",
                  "string",
                  "array",
                  "object",
                ],
              },
            }),
          },
        },
      ),
      (call) =>
        call.profile === "seed"
          ? { outer: true, inner: true, label: "outer" }
          : { outer: false, inner: false, label: "inner" },
    );
    expect(calls[1]?.task).toContain('"label": "outer"');
    expect(calls[1]?.task).toContain("inner 0");
    expect(outcome.value).toEqual({
      outer: false,
      inner: false,
      label: "inner",
    });
  });

  test("preserves enclosing map item and index roots", async () => {
    const { calls } = await run(
      seq(
        agent("seed", "items", {
          as: "list",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "map",
          over: "{list}",
          body: {
            kind: "while",
            on: "{item}",
            condition: { eq: ["continue", true] },
            max: 1,
            body: agent("worker", "item {index}: {item}; current: {current}", {
              json: {
                type: [
                  "null",
                  "boolean",
                  "number",
                  "string",
                  "array",
                  "object",
                ],
              },
            }),
          },
        },
      ),
      (call) =>
        call.profile === "seed"
          ? [{ continue: true, name: "a" }]
          : { continue: false },
    );
    expect(calls[1]?.task).toContain("item 0");
    expect(calls[1]?.task).toContain('"name": "a"');
  });

  test("cancellation stops a running while body", async () => {
    const controller = new AbortController();
    const { outcome, events } = await run(
      seq(
        agent("seed", "state", {
          as: "state",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["continue", true] },
          max: 3,
          body: agent("worker", "work"),
        },
      ),
      (call) => {
        if (call.profile === "seed") return { continue: true };
        queueMicrotask(() => controller.abort());
        return hangUntilAbort(call.signal);
      },
      { signal: controller.signal },
    );
    expect(outcome.status).toBe("stopped");
    const cancelled = eventTypes(events, "node_cancelled").map(
      (event) => (event as { path: string }).path,
    );
    expect(cancelled).toContain("$.steps[1].body");
    expect(cancelled).toContain("$.steps[1]");
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
      profile: "reviewer",
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
      (call) => (call.profile === "scout" ? "src/core" : "review-done"),
      {},
      (name) => (name === "review" ? reviewDef : undefined),
    );
    expect(outcome.value).toBe("review-done");
    expect(calls[1]?.task).toBe("review src/core at shallow");
  });

  test("exact-reference params preserve JSON values", async () => {
    const identityDef: WorkflowLike = {
      name: "identity",
      params: [{ name: "input", required: true }],
      flow: { kind: "value", value: "{params.input}" },
    };
    const input = { outcome: "changes_required", findings: [1, 2] };
    const { outcome, calls } = await run(
      seq(
        { kind: "value", value: input, as: "state" },
        {
          kind: "workflow",
          name: "identity",
          params: { input: "{state}" },
        },
      ),
      () => "unused",
      { budgets: { maxAgents: 0 } },
      (name) => (name === "identity" ? identityDef : undefined),
    );
    expect(outcome).toMatchObject({ status: "completed", value: input });
    expect(calls).toHaveLength(0);
  });

  test("undefined exact-reference roots normalize to null", async () => {
    const identityDef: WorkflowLike = {
      name: "identity",
      params: [{ name: "input", required: true }],
      flow: { kind: "value", value: "{params.input}" },
    };
    const { outcome } = await run(
      {
        kind: "loop",
        max: 1,
        body: {
          kind: "workflow",
          name: "identity",
          params: { input: "{last.missing}" },
        },
      },
      () => "unused",
      { budgets: { maxAgents: 0 } },
      (name) => (name === "identity" ? identityDef : undefined),
    );
    expect(outcome).toMatchObject({ status: "completed", value: null });
  });

  test("mixed-text params still interpolate as strings", async () => {
    const identityDef: WorkflowLike = {
      name: "identity",
      params: [{ name: "input", required: true }],
      flow: { kind: "value", value: "{params.input}" },
    };
    const { outcome } = await run(
      seq(
        { kind: "value", value: { count: 2 }, as: "state" },
        {
          kind: "workflow",
          name: "identity",
          params: { input: "state: {state}" },
        },
      ),
      () => "unused",
      { budgets: { maxAgents: 0 } },
      (name) => (name === "identity" ? identityDef : undefined),
    );
    expect(outcome.value).toBe('state: {\n  "count": 2\n}');
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
  test("maxAgents budget fails without counting the denied execution", async () => {
    const { outcome, calls } = await run(
      seq(agent("a", "1"), agent("a", "2"), agent("a", "3")),
      () => "ok",
      { budgets: { maxAgents: 2 } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("agent budget exceeded (maxAgents: 2)");
    expect(outcome.agents).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("maxAgents zero prohibits execution before calling the runner", async () => {
    const { outcome, calls } = await run(agent("a", "work"), () => "unused", {
      budgets: { maxAgents: 0 },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain(
      "agent execution prohibited (maxAgents: 0)",
    );
    expect(outcome.agents).toBe(0);
    expect(calls).toHaveLength(0);
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

describe("switch", () => {
  const gateSwitch = (
    cases: unknown[],
    elseArm: unknown,
    extra: Record<string, unknown> = {},
  ) =>
    seq(
      agent("gate", "inspect", {
        as: "gate",
        json: {
          type: ["null", "boolean", "number", "string", "array", "object"],
        },
      }),
      {
        kind: "switch",
        on: "{gate}",
        cases,
        else: elseArm,
        ...extra,
      },
    );

  test("first matching case wins; later truthy cases never run", async () => {
    const { outcome, calls } = await run(
      gateSwitch(
        [
          { when: { eq: ["status", "approved"] }, then: agent("first", "a") },
          { when: { exists: "status" }, then: agent("second", "b") },
        ],
        agent("fallback", "c"),
      ),
      (call) =>
        call.profile === "gate"
          ? { status: "approved" }
          : `${call.profile}-ran`,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toBe("first-ran");
    expect(calls.map((call) => call.profile)).toEqual(["gate", "first"]);
  });

  test("falls through to else when no case matches", async () => {
    const { outcome, calls } = await run(
      gateSwitch(
        [{ when: { eq: ["status", "approved"] }, then: agent("first", "a") }],
        agent("fallback", "c"),
      ),
      (call) =>
        call.profile === "gate"
          ? { status: "rejected" }
          : `${call.profile}-ran`,
    );
    expect(outcome.value).toBe("fallback-ran");
    expect(calls.map((call) => call.profile)).toEqual(["gate", "fallback"]);
  });

  test("the switch's value binds via as for later steps", async () => {
    const { calls } = await run(
      seq(
        agent("gate", "inspect", {
          as: "gate",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "switch",
          on: "{gate}",
          cases: [{ when: { exists: "go" }, then: agent("worker", "work") }],
          else: agent("idle", "idle"),
          as: "outcome",
        },
        agent("closer", "wrap up {outcome}"),
      ),
      (call) => (call.profile === "gate" ? { go: 1 } : `${call.profile}-done`),
    );
    expect(calls[2]?.task).toBe("wrap up worker-done");
  });

  test("an unresolvable on path fails the node with a switch.on message", async () => {
    const { outcome, events } = await run(
      gateSwitch(
        [{ when: { exists: "x" }, then: agent("a", "t") }],
        agent("b", "t"),
        { on: "{gate.decision.state}" },
      ),
      () => ({ status: "ok" }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain(
      "switch.on: path 'decision.state' not found in {gate}",
    );
    expect(eventTypes(events, "node_failed").length).toBeGreaterThanOrEqual(1);
  });

  test("an unknown on reference fails with a switch.on message", async () => {
    const { runner } = makeRunner(() => "ok");
    const outcome = await executeFlow({
      runId: "run-x",
      flow: {
        kind: "switch",
        on: "{ghost}",
        cases: [{ when: { exists: "x" }, then: { kind: "agent", task: "t" } }],
        else: { kind: "agent", task: "t" },
      } as FlowNode,
      runAgent: runner,
      emit: () => {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("switch.on: unknown reference {ghost}");
  });

  test('the "" path matches whole non-object subjects', async () => {
    const { outcome } = await run(
      seq(agent("gate", "inspect", { as: "gate" }), {
        kind: "switch",
        on: "{gate}",
        cases: [{ when: { eq: ["", "yes"] }, then: agent("worker", "go") }],
        else: agent("idle", "idle"),
      }),
      (call) => (call.profile === "gate" ? "yes" : `${call.profile}-ran`),
    );
    expect(outcome.value).toBe("worker-ran");
  });

  test("missing paths: eq/exists are false, ne/empty are true", async () => {
    const routed = async (when: unknown) => {
      const { calls } = await run(
        gateSwitch([{ when, then: agent("hit", "h") }], agent("miss", "m")),
        (call) => (call.profile === "gate" ? {} : "done"),
      );
      return calls[1]?.profile;
    };
    expect(await routed({ eq: ["missing", "x"] })).toBe("miss");
    expect(await routed({ exists: "missing" })).toBe("miss");
    expect(await routed({ ne: ["missing", "x"] })).toBe("hit");
    expect(await routed({ empty: "missing" })).toBe("hit");
  });

  test("on {last} inside a loop routes differently across iterations", async () => {
    const { outcome, calls, events } = await run(
      {
        kind: "loop",
        max: 3,
        until: { eq: ["", "done"] },
        body: {
          kind: "switch",
          on: "{last}",
          cases: [
            {
              when: { eq: ["", "continue"] },
              then: agent("resumer", "resume"),
            },
          ],
          else: agent("starter", "start"),
        },
      },
      (call) => (call.profile === "starter" ? "continue" : "done"),
    );
    expect(outcome.value).toBe("done");
    expect(calls.map((call) => call.profile)).toEqual(["starter", "resumer"]);
    const instances = eventTypes(events, "node_started").map(
      (event) => (event as { instance: string }).instance,
    );
    expect(instances).toContain("$.body#0.else");
    expect(instances).toContain("$.body#1.cases[0].then");
  });

  test("events address the switch and only the executed arm", async () => {
    const { events } = await run(
      gateSwitch(
        [{ when: { eq: ["status", "approved"] }, then: agent("shipper", "s") }],
        agent("reporter", "r"),
      ),
      (call) => (call.profile === "gate" ? { status: "approved" } : "shipped"),
    );
    const started = eventTypes(events, "node_started") as {
      path: string;
      kind: string;
    }[];
    const switchStart = started.find((event) => event.path === "$.steps[1]");
    expect(switchStart?.kind).toBe("switch");
    expect(started.map((event) => event.path)).toContain(
      "$.steps[1].cases[0].then",
    );
    const touched = events
      .filter((event) => "path" in event)
      .map((event) => (event as { path: string }).path);
    expect(touched).not.toContain("$.steps[1].else");
    const completed = eventTypes(events, "node_completed").find(
      (event) => (event as { path: string }).path === "$.steps[1]",
    ) as { value: unknown };
    expect(completed.value).toBe("shipped");
  });

  test("cancellation mid-arm cancels the arm and the switch", async () => {
    const controller = new AbortController();
    const { outcome, events } = await run(
      gateSwitch(
        [{ when: { eq: ["go", true] }, then: agent("worker", "work") }],
        agent("idle", "idle"),
      ),
      (call) => {
        if (call.profile === "gate") return { go: true };
        queueMicrotask(() => controller.abort());
        return hangUntilAbort(call.signal);
      },
      { signal: controller.signal },
    );
    expect(outcome.status).toBe("stopped");
    const cancelled = eventTypes(events, "node_cancelled").map(
      (event) => (event as { path: string }).path,
    );
    expect(cancelled).toContain("$.steps[1].cases[0].then");
    expect(cancelled).toContain("$.steps[1]");
  });

  test("the switch itself consumes no agent budget", async () => {
    const { outcome } = await run(
      gateSwitch(
        [{ when: { exists: "go" }, then: agent("worker", "work") }],
        agent("idle", "idle"),
      ),
      (call) => (call.profile === "gate" ? { go: 1 } : "ok"),
      { budgets: { maxAgents: 2 } },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.agents).toBe(2);
  });
});

describe("value", () => {
  test("node-heavy value flows run with maxAgents zero", async () => {
    const { outcome, calls } = await run(
      {
        kind: "parallel",
        branches: {
          left: seq(
            { kind: "value", value: "l1" },
            { kind: "value", value: "l2" },
          ),
          right: seq(
            { kind: "value", value: "r1" },
            { kind: "value", value: "r2" },
          ),
        },
      },
      () => "unused",
      { budgets: { maxAgents: 0 } },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ left: "l2", right: "r2" });
    expect(outcome.agents).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("dynamically unreachable agents are legal with maxAgents zero", async () => {
    const { outcome, calls } = await run(
      seq(
        { kind: "value", value: { run: false }, as: "gate" },
        {
          kind: "switch",
          on: "{gate}",
          cases: [
            {
              when: { eq: ["run", true] },
              then: agent("worker", "work"),
            },
          ],
          else: { kind: "value", value: "skipped" },
        },
        { kind: "value", value: [], as: "worklist" },
        {
          kind: "map",
          over: "{worklist}",
          body: agent("worker", "work on {item}"),
        },
      ),
      () => "unused",
      { budgets: { maxAgents: 0 } },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual([]);
    expect(outcome.agents).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a literal value passes through and spawns no agents", async () => {
    const { outcome, calls, events } = await run(
      { kind: "value", value: { a: 1, b: [true, null] } },
      () => "unused",
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ a: 1, b: [true, null] });
    expect(outcome.agents).toBe(0);
    expect(calls).toHaveLength(0);
    const started = eventTypes(events, "node_started")[0] as { kind: string };
    expect(started.kind).toBe("value");
  });

  test("single-reference strings substitute values; mixed strings interpolate", async () => {
    const { outcome } = await run(
      seq(
        agent("scout", "scan", {
          as: "scout",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "value",
          value: {
            files: "{scout.files}",
            count: "{scout.count}",
            summary: "found {scout.count} files",
            nested: [{ first: "{scout.files.0}" }, 42, true],
          },
        },
      ),
      () => ({ files: ["a.ts", "b.ts"], count: 2 }),
    );
    expect(outcome.value).toEqual({
      files: ["a.ts", "b.ts"],
      count: 2,
      summary: "found 2 files",
      nested: [{ first: "a.ts" }, 42, true],
    });
  });

  test("an unresolvable path fails the node", async () => {
    const { outcome } = await run(
      seq(
        agent("scout", "scan", {
          as: "scout",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "value",
          value: "{scout.nope}",
        },
      ),
      () => ({}),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("value: path 'nope' not found in {scout}");
  });

  test("an exact reference resolving to undefined normalizes to null", async () => {
    // {last} is undefined on iteration 0; JSON events cannot carry undefined.
    const { outcome } = await run(
      {
        kind: "loop",
        max: 1,
        body: { kind: "value", value: { prior: "{last}", note: "was {last}" } },
      },
      () => "unused",
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({ prior: null, note: "was " });
    expect(JSON.parse(JSON.stringify(outcome.value))).toEqual(outcome.value);
  });

  test("a value arm yields an existing binding without an echo agent", async () => {
    const { outcome, calls } = await run(
      seq(
        agent("review", "review the change", {
          as: "review",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
        }),
        {
          kind: "switch",
          on: "{review}",
          cases: [{ when: { eq: ["pr", true] }, then: agent("codex", "gate") }],
          else: {
            kind: "value",
            value: { outcome: "{review.outcome}", gated: false },
          },
        },
      ),
      (call) =>
        call.profile === "review" ? { pr: false, outcome: "clean" } : "gated",
    );
    expect(outcome.value).toEqual({ outcome: "clean", gated: false });
    expect(calls.map((call) => call.profile)).toEqual(["review"]);
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
    expect(created.run.flow.kind).toBe("sequence");
    const started = eventTypes(events, "node_started").map(
      (e) => (e as { path: string }).path,
    );
    expect(started).toEqual(["$", "$.steps[0]", "$.steps[1]"]);
    const last = events[events.length - 1] as { type: string; status: string };
    expect(last.type).toBe("run_completed");
    expect(last.status).toBe("completed");
  });
});

describe("run-level execution budgets", () => {
  test("maxDuration fails the run and cancels nodes with reason budget", async () => {
    const { outcome, events } = await run(
      agent("a", "t"),
      (call) => hangUntilAbort(call.signal),
      { budgets: { maxDuration: 0.02 } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain(
      "run duration budget exceeded (maxDuration: 0.02s)",
    );
    const cancelled = events.find((e) => e.type === "node_cancelled") as {
      reason: string;
    };
    expect(cancelled.reason).toBe("budget");
  });

  test("maxDuration waits until an attached user releases the run", async () => {
    let held = true;
    let settled = false;
    const pending = run(
      agent("a", "t"),
      (call) => hangUntilAbort(call.signal),
      { budgets: { maxDuration: 0.01 }, isHeld: () => held },
    ).finally(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false);
    held = false;
    const { outcome } = await pending;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("run duration budget exceeded");
  });

  test("maxCost fails the run once cumulative cost exceeds it", async () => {
    // Each fake agent completion costs $0.01 (see makeRunner).
    const { outcome, calls } = await run(
      seq(agent("a", "1"), agent("b", "2"), agent("c", "3")),
      () => "ok",
      { budgets: { maxCost: 0.015 } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("cost budget exceeded (maxCost: $0.015)");
    expect(calls.length).toBe(2);
  });

  test("maxTokens aborts mid-agent at turn granularity", async () => {
    const flow = validateFlow(agent("a", "t"), {});
    const events: RunEvent[] = [];
    const outcome = await executeFlow({
      runId: "run-tokens",
      flow,
      budgets: { maxTokens: 500 },
      emit: (event) => events.push(event),
      runAgent: async (call) => {
        const usage = emptyUsage();
        usage.input = 400;
        usage.output = 200;
        call.onProgress?.({ text: "streaming half an answer", usage });
        await hangUntilAbort(call.signal);
        return { value: "unreachable" };
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("token budget exceeded (maxTokens: 500)");
    const cancelled = events.find((e) => e.type === "node_cancelled") as {
      reason: string;
    };
    expect(cancelled.reason).toBe("budget");
  });

  test("token and cost breaches wait for an attached user", async () => {
    let held = true;
    const flow = validateFlow(agent("a", "t"), {});
    const start = (
      runId: string,
      budgets: { maxTokens?: number; maxCost?: number },
      usage: ReturnType<typeof emptyUsage>,
    ) =>
      executeFlow({
        runId,
        flow,
        budgets,
        isHeld: () => held,
        runAgent: async (call) => {
          call.onProgress?.({ text: "still attached", usage });
          await hangUntilAbort(call.signal);
          return { value: "unreachable" };
        },
      });

    const tokenUsage = emptyUsage();
    tokenUsage.input = 600;
    const costUsage = emptyUsage();
    costUsage.cost = 1;
    let settled = 0;
    const tokenRun = start(
      "held-tokens",
      { maxTokens: 500 },
      tokenUsage,
    ).finally(() => {
      settled += 1;
    });
    const costRun = start("held-cost", { maxCost: 0.5 }, costUsage).finally(
      () => {
        settled += 1;
      },
    );
    await Bun.sleep(30);
    expect(settled).toBe(0);
    held = false;
    const [tokenOutcome, costOutcome] = await Promise.all([tokenRun, costRun]);
    expect(tokenOutcome.error).toContain("token budget exceeded");
    expect(costOutcome.error).toContain("cost budget exceeded");
  });

  test("a pending breach wins when an agent settles immediately after detach", async () => {
    let held = true;
    let finish!: () => void;
    const releaseAgent = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const flow = validateFlow(agent("a", "t"), {});
    const pending = executeFlow({
      runId: "held-settle-race",
      flow,
      budgets: { maxTokens: 500 },
      isHeld: () => held,
      runAgent: async (call) => {
        const usage = emptyUsage();
        usage.input = 600;
        call.onProgress?.({ text: "done", usage });
        await releaseAgent;
        return { value: "result", usage };
      },
    });
    await Bun.sleep(30);
    held = false;
    finish();
    const outcome = await pending;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("token budget exceeded");
  });

  test("a budget-cut agent's partial text lands in node_failed", async () => {
    const { outcome, events } = await run(agent("a", "t"), () => {
      throw new BudgetExceededError(
        "agent turn budget exceeded (maxTurns: 2)",
        "partial work",
      );
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("maxTurns: 2");
    const failed = events.find((e) => e.type === "node_failed") as {
      partialText?: string;
    };
    expect(failed.partialText).toBe("partial work");
  });

  test("collect mode keeps sibling results when one agent hits its budget", async () => {
    const { outcome } = await run(
      {
        kind: "parallel",
        branches: {
          good: agent("a", "fine"),
          greedy: agent("b", "over budget"),
        },
        onError: "collect",
      },
      (call) => {
        if (call.task === "over budget") {
          throw new BudgetExceededError(
            "agent turn budget exceeded (maxTurns: 1)",
            "half done",
          );
        }
        return "ok";
      },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toEqual({
      good: "ok",
      greedy: { error: "agent turn budget exceeded (maxTurns: 1)" },
    });
  });
});

describe("budget cancellation reasons in pools", () => {
  test("parallel children cancel with reason budget on a run-level breach", async () => {
    const { outcome, events } = await run(
      {
        kind: "parallel",
        branches: { a: agent("a", "1"), b: agent("b", "2") },
      },
      (call) => hangUntilAbort(call.signal),
      { budgets: { maxDuration: 0.02 } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("run duration budget exceeded");
    const reasons = events
      .filter((e) => e.type === "node_cancelled")
      .map((e) => (e as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reasons)).toEqual(new Set(["budget"]));
  });

  test("map items cancel with reason budget on a run-level breach", async () => {
    const { outcome, events } = await run(
      {
        kind: "sequence",
        steps: [
          agent("s", "list", {
            as: "targets",
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
          }),
          { kind: "map", over: "{targets}", body: agent("m", "work {item}") },
        ],
      },
      (call) => (call.task === "list" ? [1, 2] : hangUntilAbort(call.signal)),
      { budgets: { maxDuration: 0.05 } },
    );
    expect(outcome.status).toBe("failed");
    const reasons = events
      .filter((e) => e.type === "node_cancelled")
      .map((e) => (e as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reasons)).toEqual(new Set(["budget"]));
  });
});
