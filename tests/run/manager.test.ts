import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  SpawnEngine,
  SpawnHandle,
  SpawnSpec,
} from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import { validateFlow } from "../../src/model/validate.js";
import { RunManager } from "../../src/run/runs.js";

let projectDir: string;
let otherDir: string;

function writeAgent(dir: string, name: string): void {
  const agentsDir = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: d\n---\nBody.\n`,
  );
}

async function* emptyUpdates(): AsyncGenerator<never> {
  // no streamed updates
}

function fakeEngine(
  handler: (spec: SpawnSpec) => string | Promise<string> = () => "ok",
): { engine: SpawnEngine; specs: SpawnSpec[] } {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    engine: {
      spawn(spec) {
        specs.push(spec);
        return {
          status: "completed",
          updates: emptyUpdates(),
          wait: async () => ({
            text: await handler(spec),
            exitCode: 0,
            usage: emptyUsage(),
          }),
          abort: () => {},
        };
      },
    },
  };
}

function steerableEngine(): {
  engine: SpawnEngine;
  messages: string[];
  finish: () => void;
} {
  const messages: string[] = [];
  let status: SpawnHandle["status"] = "running";
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = () => {
      status = "completed";
      resolve();
    };
  });
  return {
    messages,
    finish,
    engine: {
      spawn() {
        return {
          get status() {
            return status;
          },
          updates: emptyUpdates(),
          async wait() {
            await completion;
            return { text: "ok", exitCode: 0, usage: emptyUsage() };
          },
          async steer(message) {
            messages.push(message);
          },
          abort() {},
        };
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-mgr-"));
  otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-mgr-other-"));
  writeAgent(projectDir, "echo");
  writeAgent(otherDir, "elsewhere");
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});

describe("preflight with node overrides", () => {
  test("an agent that exists only under its node's cwd passes", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "agent",
      name: "elsewhere",
      task: "t",
      cwd: otherDir,
      scope: "project",
    });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(specs[0]?.cwd).toBe(otherDir);
  });

  test("an agent missing under its node's cwd fails before any spawn", () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "agent", name: "echo", task: "first" },
        {
          kind: "agent",
          name: "echo",
          task: "second",
          cwd: otherDir,
          scope: "project",
        },
      ],
    });
    expect(() =>
      manager.start({
        flow,
        cwd: projectDir,
        scope: "project",
        source: { kind: "tool" },
      }),
    ).toThrow(/unknown agent 'echo' \(cwd: .*scope: project\)/);
    expect(specs).toHaveLength(0);
  });
});

describe("preflight diagnostics", () => {
  test("a same-named agent file that fails to parse is surfaced", () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "broken.md"),
      "---\nname: broken\ndescription: d\nbogus: key\n---\nBody.\n",
    );
    const { engine } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "broken", task: "t" });
    expect(() =>
      manager.start({
        flow,
        cwd: projectDir,
        scope: "project",
        source: { kind: "tool" },
      }),
    ).toThrow(
      /unknown agent 'broken'.*broken\.md: Unsupported frontmatter keys: bogus/,
    );
  });
});

describe("budgets", () => {
  test("rejects non-positive or fractional budget values", () => {
    const { engine } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "echo", task: "t" });
    for (const budgets of [
      { maxAgents: -1 },
      { maxParallelism: 0 },
      { maxIterations: 1.5 },
    ]) {
      expect(() =>
        manager.start({
          flow,
          cwd: projectDir,
          scope: "project",
          source: { kind: "tool" },
          budgets,
        }),
      ).toThrow("must be an integer >= 1");
    }
  });

  test("maxParallelism caps agents globally across nested pools", async () => {
    let running = 0;
    let peak = 0;
    const { engine } = fakeEngine(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return "ok";
    });
    const manager = new RunManager({ engine });
    const branch = (key: string) => ({
      kind: "parallel",
      branches: {
        [`${key}1`]: { kind: "agent", name: "echo", task: "t" },
        [`${key}2`]: { kind: "agent", name: "echo", task: "t" },
      },
    });
    const flow = validateFlow({
      kind: "parallel",
      branches: { a: branch("a"), b: branch("b") },
    });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      budgets: { maxParallelism: 2 },
    });
    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(outcome.agents).toBe(4);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("effective budget limits propagate to children via env", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "echo", task: "t" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      budgets: { maxDepth: 1, maxAgents: 7 },
    });
    await done;
    const env = specs[0]?.env ?? {};
    expect(env.PI_AGENTS_DEPTH).toBe("1");
    const inherited = JSON.parse(env.PI_AGENTS_BUDGETS ?? "{}");
    expect(inherited).toMatchObject({ maxDepth: 1, maxAgents: 7 });
  });

  test("inherited defaults apply but per-run budgets win", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({
      engine,
      defaultBudgets: { maxAgents: 3, maxIterations: 2 },
    });
    const flow = validateFlow({ kind: "agent", name: "echo", task: "t" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      budgets: { maxAgents: 9 },
    });
    await done;
    const inherited = JSON.parse(specs[0]?.env?.PI_AGENTS_BUDGETS ?? "{}");
    expect(inherited).toMatchObject({ maxAgents: 9, maxIterations: 2 });
  });
});

describe("session defaults", () => {
  test("agents without frontmatter inherit model and thinking", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "echo", task: "t" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      defaults: { model: "prov/session-model", thinking: "high" },
    });
    await done;
    expect(specs[0]?.model).toBe("prov/session-model");
    expect(specs[0]?.thinking).toBe("high");
  });

  test("agent frontmatter wins over session defaults", async () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "picky.md"),
      "---\nname: picky\ndescription: d\nmodel: my-model\nthinking: low\n---\nBody.\n",
    );
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "picky", task: "t" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      defaults: { model: "prov/session-model", thinking: "high" },
    });
    await done;
    expect(specs[0]?.model).toBe("my-model");
    expect(specs[0]?.thinking).toBe("low");
  });
});

describe("node overrides", () => {
  test("node model/thinking overrides beat agent file and session defaults", async () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "picky2.md"),
      "---\nname: picky2\ndescription: d\nmodel: file-model\nthinking: high\n---\nBody.\n",
    );
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "agent",
      name: "picky2",
      task: "t",
      model: "node-model",
      thinking: "minimal",
    });
    await manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      defaults: { model: "session-model", thinking: "low" },
    }).done;
    expect(specs[0]?.model).toBe("node-model");
    expect(specs[0]?.thinking).toBe("minimal");
  });
});

describe("ad-hoc agents", () => {
  test("an anonymous leaf runs without any agent directories", async () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-bare-"));
    try {
      const { engine, specs } = fakeEngine();
      const manager = new RunManager({ engine });
      const flow = validateFlow({ kind: "agent", task: "do the thing" });
      const { done } = manager.start({
        flow,
        cwd: bareDir,
        scope: "both",
        source: { kind: "tool" },
      });
      const outcome = await done;
      expect(outcome.status).toBe("completed");
      expect(specs[0]?.agent).toBe("ad-hoc");
      expect(specs[0]?.systemPrompt).toContain("final message"); // result contract only, no persona
      expect(specs[0]?.tools).toBeUndefined();
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("anonymous calls inherit session defaults; node overrides win", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "agent", task: "session defaults" },
        {
          kind: "agent",
          task: "overridden",
          model: "node-model",
          thinking: "minimal",
        },
      ],
    });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      defaults: { model: "prov/session-model", thinking: "high" },
    });
    await done;
    expect(specs[0]?.model).toBe("prov/session-model");
    expect(specs[0]?.thinking).toBe("high");
    expect(specs[1]?.model).toBe("node-model");
    expect(specs[1]?.thinking).toBe("minimal");
  });

  test("a mixed flow resolves named agents and passes anonymous ones through", async () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "parallel",
      branches: {
        named: { kind: "agent", name: "echo", task: "t" },
        anon: { kind: "agent", task: "t" },
      },
      reduce: { task: "merge {branches}" },
    });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(specs.map((spec) => spec.agent).sort()).toEqual([
      "ad-hoc",
      "ad-hoc",
      "echo",
    ]);
  });

  test("named unknown agents still fail preflight in an anonymous flow", () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "agent", task: "anon" },
        { kind: "agent", name: "ghost", task: "t" },
      ],
    });
    expect(() =>
      manager.start({
        flow,
        cwd: projectDir,
        scope: "project",
        source: { kind: "tool" },
      }),
    ).toThrow(/unknown agent 'ghost'/);
    expect(specs).toHaveLength(0);
  });
});

describe("empty tools allowlist", () => {
  test("tools: [] reaches the engine as an empty list, not undefined", async () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "locked.md"),
      "---\nname: locked\ndescription: d\ntools: []\n---\nBody.\n",
    );
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "locked", task: "t" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    await done;
    expect(specs[0]?.tools).toEqual([]);
  });
});

describe("live steering", () => {
  test("routes a validated message and records it only after acceptance", async () => {
    const controlled = steerableEngine();
    const manager = new RunManager({ engine: controlled.engine });
    const flow = validateFlow({ kind: "agent", name: "echo", task: "t" });
    const started = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });

    await waitFor(() => manager.steerableInstances(started.runId).length === 1);
    expect(manager.steerableInstances(started.runId)).toEqual(["$"]);
    await expect(
      manager.steer(
        started.runId,
        "$",
        "  revise the conclusion  ",
        "tool",
        "parent-agent",
      ),
    ).resolves.toEqual({
      status: "queued",
      runId: started.runId,
      instance: "$",
    });
    expect(controlled.messages).toEqual(["revise the conclusion"]);
    expect(
      manager.state.runs.get(started.runId)?.nodes.get("$")?.steering,
    ).toEqual([
      expect.objectContaining({
        message: "revise the conclusion",
        source: "tool",
        caller: "parent-agent",
      }),
    ]);

    controlled.finish();
    await started.done;
    expect(manager.steerableInstances(started.runId)).toEqual([]);
    await expect(
      manager.steer(started.runId, "$", "too late", "user"),
    ).resolves.toEqual({ status: "unavailable", reason: "run_not_live" });
  });

  test("rejects empty and oversized messages before delivery", async () => {
    const controlled = steerableEngine();
    const manager = new RunManager({ engine: controlled.engine });
    const started = manager.start({
      flow: validateFlow({ kind: "agent", name: "echo", task: "t" }),
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    await waitFor(() => manager.steerableInstances(started.runId).length === 1);

    expect(await manager.steer(started.runId, "$", "   ", "user")).toEqual({
      status: "rejected",
      error: "steering message must not be empty",
    });
    expect(
      await manager.steer(started.runId, "$", "x".repeat(2_001), "user"),
    ).toEqual({
      status: "rejected",
      error: "steering message must be at most 2000 characters",
    });
    expect(controlled.messages).toEqual([]);

    controlled.finish();
    await started.done;
  });
});
