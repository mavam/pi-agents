import { describe, expect, test } from "bun:test";
import {
  emptyUsage,
  SpawnAborted,
  type SpawnEngine,
  type SpawnProgress,
  type SpawnSpec,
} from "../../src/engine/types.js";
import { DEFAULT_BUDGETS } from "../../src/model/ast.js";
import { BudgetExceededError } from "../../src/run/budgets.js";
import type { AgentCall } from "../../src/run/interpreter.js";
import { createAgentRunner, delegationPreamble } from "../../src/run/runner.js";

/** Engine fake that records the spec and returns a canned outcome. */
function captureEngine(specs: SpawnSpec[]): SpawnEngine {
  return {
    spawn(spec) {
      specs.push(spec);
      return {
        status: "completed",
        updates: (async function* () {})(),
        wait: async () => ({ text: "ok", exitCode: 0, usage: emptyUsage() }),
        abort: () => {},
      };
    },
  };
}

function call(overrides: Partial<AgentCall> = {}): AgentCall {
  return {
    task: "do the thing",
    output: "text",
    path: "$",
    instance: "$",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("delegationPreamble", () => {
  test("states the final-message result contract", () => {
    const text = delegationPreamble("text");
    expect(text).toContain("final message");
    expect(text).toContain("deliverable");
    expect(text).not.toContain("JSON");
  });

  test("json mode adds the raw-JSON requirement", () => {
    const text = delegationPreamble("json");
    expect(text).toContain("single JSON value");
  });
});

describe("createAgentRunner system prompt", () => {
  test("ad-hoc agents get the result contract", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await runner(call());
    expect(specs[0]?.systemPrompt).toContain(delegationPreamble("text"));
  });

  test("json calls get the JSON variant", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await runner(call({ output: "json" }));
    expect(specs[0]?.systemPrompt).toContain("single JSON value");
  });
});

/** Engine fake that streams scripted updates, then hangs until aborted. */
function streamingEngine(script: SpawnProgress[]): SpawnEngine {
  return {
    spawn() {
      let aborted = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        status: "running",
        updates: (async function* () {
          for (const update of script) {
            if (aborted) break;
            yield update;
          }
          await released;
        })(),
        wait: async () => {
          await released;
          if (aborted) throw new SpawnAborted("w");
          return { text: "final", exitCode: 0, usage: emptyUsage() };
        },
        abort: () => {
          aborted = true;
          release();
        },
      };
    },
  };
}

function progress(
  turnsStarted: number,
  text = "",
  usage = emptyUsage(),
): SpawnProgress {
  return { text, usage, turnsStarted };
}

describe("createAgentRunner budget watchdog", () => {
  test("aborts when a turn beyond maxTurns starts, preserving partial text", async () => {
    const runner = createAgentRunner({
      engine: streamingEngine([
        progress(1, "thinking"),
        progress(2, "half an answer"),
        progress(3),
      ]),
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxTurns: 2 },
    });
    const failure = await runner(call()).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as BudgetExceededError).message).toContain(
      "agent turn budget exceeded (maxTurns: 2)",
    );
    expect((failure as BudgetExceededError).partialText).toBe("half an answer");
  });

  test("falls back to completed-turn counts when turnsStarted is absent", async () => {
    const over = emptyUsage();
    over.turns = 3;
    const runner = createAgentRunner({
      engine: streamingEngine([{ text: "so far", usage: over }]),
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxTurns: 2 },
    });
    await expect(runner(call())).rejects.toThrow(
      "agent turn budget exceeded (maxTurns: 2)",
    );
  });

  test("aborts after maxAgentDuration elapses", async () => {
    const runner = createAgentRunner({
      engine: streamingEngine([]),
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxAgentDuration: 0.02 },
    });
    const failure = await runner(call()).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as BudgetExceededError).message).toContain(
      "agent duration budget exceeded (maxAgentDuration: 0.02s)",
    );
  });

  test("agents within budget complete untouched", async () => {
    const runner = createAgentRunner({
      engine: {
        spawn() {
          return {
            status: "completed",
            updates: (async function* () {
              yield progress(1, "one");
            })(),
            wait: async () => ({
              text: "done",
              exitCode: 0,
              usage: emptyUsage(),
            }),
            abort: () => {
              throw new Error("must not abort");
            },
          };
        },
      },
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxTurns: 2 },
    });
    await expect(runner(call())).resolves.toEqual({
      text: "done",
      usage: emptyUsage(),
    });
  });

  test("external aborts stay SpawnAborted, not budget failures", async () => {
    const controller = new AbortController();
    const runner = createAgentRunner({
      engine: streamingEngine([progress(1)]),
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS },
    });
    const pending = runner(call({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SpawnAborted);
  });
});

describe("createAgentRunner breach/settle races", () => {
  test("a breach found while draining updates beats a completed outcome", async () => {
    // wait() resolves before the pump ever sees the over-budget update; the
    // drain must still turn the result into a budget failure.
    const engine: SpawnEngine = {
      spawn() {
        return {
          status: "completed",
          updates: (async function* () {
            yield progress(3, "late partial");
          })(),
          wait: async () => ({
            text: "done",
            exitCode: 0,
            usage: emptyUsage(),
          }),
          abort: () => {},
        };
      },
    };
    const runner = createAgentRunner({
      engine,
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxTurns: 2 },
    });
    const failure = await runner(call()).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as BudgetExceededError).partialText).toBe("late partial");
  });

  test("final outcomes are not failed retroactively on usage alone", async () => {
    // No streamed activity ever crossed the cap; a completed outcome whose
    // final usage exceeds maxTurns stays a success (streaming engines are
    // the enforcement point).
    const over = emptyUsage();
    over.turns = 5;
    const engine: SpawnEngine = {
      spawn() {
        return {
          status: "completed",
          updates: (async function* () {})(),
          wait: async () => ({ text: "done", exitCode: 0, usage: over }),
          abort: () => {},
        };
      },
    };
    const runner = createAgentRunner({
      engine,
      cwd: process.cwd(),
      budgetLimits: { ...DEFAULT_BUDGETS, maxTurns: 2 },
    });
    await expect(runner(call())).resolves.toEqual({
      text: "done",
      usage: over,
    });
  });
});
