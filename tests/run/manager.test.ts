import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnEngine, SpawnSpec } from "../../src/engine/types.js";
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
      kind: "seq",
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
      kind: "par",
      branches: {
        [`${key}1`]: { kind: "agent", name: "echo", task: "t" },
        [`${key}2`]: { kind: "agent", name: "echo", task: "t" },
      },
    });
    const flow = validateFlow({
      kind: "par",
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

describe("default tasks and node overrides", () => {
  test("a node without a task uses the agent-file default, interpolated", async () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "bug-hunter.md"),
      "---\nname: bug-hunter\ndescription: d\ntask: Hunt bugs relentlessly.\n---\nBody.\n",
    );
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "bug-hunter" });
    const { done } = manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(specs[0]?.task).toBe("Hunt bugs relentlessly.");
  });

  test("a node task overrides the agent-file default", async () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "agents", "bug-hunter.md"),
      "---\nname: bug-hunter\ndescription: d\ntask: Default task.\n---\nBody.\n",
    );
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({
      kind: "agent",
      name: "bug-hunter",
      task: "Special mission.",
    });
    await manager.start({
      flow,
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    }).done;
    expect(specs[0]?.task).toBe("Special mission.");
  });

  test("preflight rejects taskless nodes when the agent has no default", () => {
    const { engine, specs } = fakeEngine();
    const manager = new RunManager({ engine });
    const flow = validateFlow({ kind: "agent", name: "echo" });
    expect(() =>
      manager.start({
        flow,
        cwd: projectDir,
        scope: "project",
        source: { kind: "tool" },
      }),
    ).toThrow("agent 'echo' needs a task");
    expect(specs).toHaveLength(0);
  });

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
