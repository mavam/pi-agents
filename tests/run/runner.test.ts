import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
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
function captureEngine(specs: SpawnSpec[], value: unknown = "ok"): SpawnEngine {
  return {
    spawn(spec) {
      specs.push(spec);
      return {
        status: "completed",
        updates: (async function* () {})(),
        wait: async () => ({ value, exitCode: 0, usage: emptyUsage() }),
        abort: () => {},
      };
    },
  };
}

function call(overrides: Partial<AgentCall> = {}): AgentCall {
  return {
    task: "do the thing",
    path: "$",
    instance: "$",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("delegationPreamble", () => {
  test("states the explicit result-submission contract", () => {
    const text = delegationPreamble();
    expect(text).toContain("not fresh user intent");
    expect(text).toContain("Do not invoke workflows or delegate it further");
    expect(text).toContain("perform the underlying work");
    expect(text).toContain("submitting exactly one complete agent result");
    expect(text).toContain("Assistant messages are progress");
    expect(text).toContain("submit an error with a concrete reason");
    expect(text).not.toContain("pi_agents_submit_result");
  });
});

describe("createAgentRunner", () => {
  test("ad-hoc agents get the result contract", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await runner(call());
    expect(specs[0]?.systemPrompt).toContain(delegationPreamble());
    expect(specs[0]?.disableSkillDiscovery).toBe(false);
    expect(specs[0]?.resultSchema).toBeUndefined();
  });

  test("structured calls forward their result schema", async () => {
    const specs: SpawnSpec[] = [];
    const resultSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    const runner = createAgentRunner({
      engine: captureEngine(specs, { ok: true }),
      cwd: process.cwd(),
    });
    await runner(call({ resultSchema }));
    expect(specs[0]?.resultSchema).toBe(resultSchema);
  });

  test("rejects non-string text outcomes from custom engines", async () => {
    const runner = createAgentRunner({
      engine: captureEngine([], { unexpected: true }),
      cwd: process.cwd(),
    });
    await expect(runner(call())).rejects.toThrow(
      "violates the declared result schema",
    );
  });

  test("accepts structured JSON outcomes from custom engines", async () => {
    const value = { expected: true };
    const resultSchema = {
      type: "object",
      properties: { expected: { type: "boolean" } },
      required: ["expected"],
      additionalProperties: false,
    };
    const runner = createAgentRunner({
      engine: captureEngine([], value),
      cwd: process.cwd(),
    });
    await expect(runner(call({ resultSchema }))).resolves.toMatchObject({
      value,
    });
  });

  test("rejects results that violate a concrete schema", async () => {
    const runner = createAgentRunner({
      engine: captureEngine([], { expected: "yes" }),
      cwd: process.cwd(),
    });
    await expect(
      runner(
        call({
          resultSchema: {
            type: "object",
            properties: { expected: { type: "boolean" } },
            required: ["expected"],
          },
        }),
      ),
    ).rejects.toThrow("violates the declared result schema");
  });

  test("rejects non-JSON values even when the schema would accept objects", async () => {
    const runner = createAgentRunner({
      engine: captureEngine([], new Date(0)),
      cwd: process.cwd(),
    });
    await expect(
      runner(call({ resultSchema: { type: "object" } })),
    ).rejects.toThrow("non-JSON Date");
  });

  test("an anonymous call renders the skills it asked for", async () => {
    const skillsDir = path.join(
      process.env.PI_CODING_AGENT_DIR as string,
      "skills",
      "runner-skill",
    );
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: runner-skill\ndescription: d\n---\nFollow the runner rules.\n",
    );
    try {
      const specs: SpawnSpec[] = [];
      const runner = createAgentRunner({
        engine: captureEngine(specs),
        cwd: process.cwd(),
      });
      await runner(call({ skills: ["runner-skill"] }));
      const prompt = specs[0]?.systemPrompt ?? "";
      expect(prompt).toContain('<skill name="runner-skill"');
      expect(prompt).toContain("Follow the runner rules.");
      // Order: skills first, result contract last; no profile persona exists.
      expect(prompt.indexOf("runner-skill")).toBeLessThan(
        prompt.indexOf(delegationPreamble()),
      );
      expect(specs[0]?.disableSkillDiscovery).toBe(true);
      expect(specs[0]?.agent).toBe("ad-hoc");
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  test("an explicit empty skill list disables ambient discovery", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await runner(call({ skills: [] }));
    expect(specs[0]?.systemPrompt).not.toContain("<skill");
    expect(specs[0]?.disableSkillDiscovery).toBe(true);
  });

  test("an unresolvable skill fails the call instead of degrading the prompt", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await expect(runner(call({ skills: ["no-such-skill"] }))).rejects.toThrow(
      /unknown skill 'no-such-skill'/,
    );
    expect(specs).toHaveLength(0);
  });

  test("tool allowlists reach the engine, empty list included", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
    });
    await runner(call({ tools: ["read", "grep"] }));
    await runner(call({ tools: [] }));
    await runner(call());
    expect(specs[0]?.tools).toEqual(["read", "grep"]);
    expect(specs[1]?.tools).toEqual([]);
    expect(specs[2]?.tools).toBeUndefined();
  });

  test("model and thinking overrides win over session defaults", async () => {
    const specs: SpawnSpec[] = [];
    const runner = createAgentRunner({
      engine: captureEngine(specs),
      cwd: process.cwd(),
      defaults: { model: "session-model", thinking: "low" },
    });
    await runner(call({ model: "call-model" }));
    expect(specs[0]?.model).toBe("call-model");
    expect(specs[0]?.thinking).toBe("low");
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
          return { value: "final", exitCode: 0, usage: emptyUsage() };
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
              value: "done",
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
      value: "done",
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
            value: "done",
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
          wait: async () => ({ value: "done", exitCode: 0, usage: over }),
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
      value: "done",
      usage: over,
    });
  });
});
