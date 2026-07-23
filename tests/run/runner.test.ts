import { describe, expect, test } from "bun:test";
import {
  emptyUsage,
  type SpawnEngine,
  type SpawnSpec,
} from "../../src/engine/types.js";
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
