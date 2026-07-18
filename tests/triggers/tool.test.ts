import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnEngine, SpawnSpec } from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import { RunManager } from "../../src/run/runs.js";
import { parseCommandArgs } from "../../src/triggers/commands.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import { createWorkflowTool } from "../../src/triggers/tool.js";
import { NotificationManager } from "../../src/ui/notify.js";
import { RunWidget } from "../../src/ui/widget.js";

function makeDeps(engine: SpawnEngine): TriggerDeps {
  const manager = new RunManager({ engine });
  const pi = {
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  return {
    pi,
    manager,
    notifications: new NotificationManager(pi, manager),
    widget: new RunWidget(manager),
  };
}

let projectDir: string;

async function* emptyUpdates(): AsyncGenerator<never> {
  // No streamed updates in the fake engine.
}

function fakeEngine(handler: (spec: SpawnSpec) => string): {
  engine: SpawnEngine;
  specs: SpawnSpec[];
} {
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
            text: handler(spec),
            exitCode: 0,
            usage: emptyUsage(),
          }),
          abort: () => {},
        };
      },
    },
  };
}

function writeFile(relative: string, content: string): void {
  const filePath = path.join(projectDir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-tool-"));
  writeFile(
    ".pi/agents/echo.md",
    "---\nname: echo\ndescription: echoes\n---\nEcho the task back.\n",
  );
  writeFile(
    ".pi/agents/reviewer.md",
    "---\nname: reviewer\ndescription: reviews\ntools: read, grep\n---\nReview.\n",
  );
  writeFile(
    ".pi/workflows/greet.yaml",
    'name: greet\ndescription: greets a target\nparams:\n  - name: target\n    required: true\nflow: { kind: agent, name: echo, task: "greet {params.target}" }\n',
  );
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const ctx = () => ({ cwd: projectDir }) as unknown as ExtensionContext;

describe("workflow tool", () => {
  test("runs an inline bare agent leaf", async () => {
    const { engine, specs } = fakeEngine((spec) => `echo: ${spec.task}`);
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t1",
      {
        flow: { kind: "agent", name: "echo", task: "hello" },
        scope: "project",
      },
      undefined,
      undefined,
      ctx(),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('status="completed"');
    expect(text).toContain("echo: hello");
    expect(result.details.status).toBe("completed");
    expect(specs[0]?.systemPrompt).toContain("Echo the task back.");
  });

  test("runs a saved workflow by name with params", async () => {
    const { engine } = fakeEngine((spec) => `ran: ${spec.task}`);
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t2",
      { name: "greet", params: { target: "world" }, scope: "project" },
      undefined,
      undefined,
      ctx(),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ran: greet world");
    expect(result.details.label).toBe("greet");
  });

  test("passes the agent tools allowlist to the engine", async () => {
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    await tool.execute(
      "t3",
      {
        flow: { kind: "agent", name: "reviewer", task: "review" },
        scope: "project",
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(specs[0]?.tools).toEqual(["read", "grep"]);
  });

  test("rejects passing both name and flow", async () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    expect(
      tool.execute(
        "t4",
        { name: "greet", flow: { kind: "agent" } },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow("exactly one");
  });

  test("unknown saved workflow lists what exists", async () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    expect(
      tool.execute(
        "t5",
        { name: "nope", scope: "project" },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow("Available: greet");
  });

  test("invalid inline flows carry node-path errors", async () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    expect(
      tool.execute(
        "t6",
        {
          flow: {
            kind: "sequence",
            steps: [{ kind: "agent", name: "echo", task: "use {ghost}" }],
          },
          scope: "project",
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow("$.steps[0].task: unknown reference {ghost}");
  });

  test("unknown agents are caught in preflight before any spawn", async () => {
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    await expect(
      tool.execute(
        "t7",
        { flow: { kind: "agent", name: "ghost", task: "t" }, scope: "project" },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow("unknown agent 'ghost'");
    expect(specs).toHaveLength(0);
  });

  test("failed runs return an error result", async () => {
    const failingEngine: SpawnEngine = {
      spawn(spec) {
        return {
          status: "failed",
          updates: emptyUpdates(),
          wait: async () => {
            throw new Error(`Agent ${spec.agent} failed: exploded`);
          },
          abort: () => {},
        };
      },
    };
    const tool = createWorkflowTool(makeDeps(failingEngine));
    const result = await tool.execute(
      "t8",
      { flow: { kind: "agent", name: "echo", task: "boom" }, scope: "project" },
      undefined,
      undefined,
      ctx(),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('status="failed"');
    expect(text).toContain("exploded");
  });
});

describe("call and result previews", () => {
  test("saved workflow calls show icon, name, dim label, and params", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const preview = formatCallPreview({
      name: "review",
      label: "Review current changes (retry)",
      params: {
        target:
          "current working tree changes (git diff); inspect repository state and review all local changes",
      },
    });
    const lines = preview.split("\n");
    expect(lines[0]).toBe("❖ review · Review current changes (retry)");
    expect(lines[1]).toContain("   target: current working tree changes");
    expect(lines[1]).toContain("…");
    expect(preview).not.toContain("workflow ·");
  });

  test("saved workflows resolve and render their full expanded tree", async () => {
    const { resolveSavedFlowTree, formatCallPreview } = await import(
      "../../src/triggers/tool.js"
    );
    const tree = resolveSavedFlowTree("greet", projectDir);
    expect(tree).toBe("✦ echo · greet {params.target}");
    const preview = formatCallPreview(
      { name: "greet", params: { target: "world" } },
      undefined,
      tree,
    );
    expect(preview.split("\n")).toEqual([
      "❖ greet",
      "   target: world",
      "✦ echo · greet {params.target}",
    ]);
    expect(resolveSavedFlowTree("nonexistent", projectDir)).toBeUndefined();
  });

  test("inline flows render as the icon tree", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const preview = formatCallPreview({
      flow: { kind: "agent", name: "echo", task: "hello" },
    });
    expect(preview).toBe("✦ echo · hello");
  });

  test("result preview replaces the model-facing continuation text", async () => {
    const { formatResultPreview } = await import("../../src/triggers/tool.js");
    const running = formatResultPreview(
      {
        details: { runId: "b3ca589a-0000", status: "running", label: "review" },
        text: "Started workflow run … End your turn now — do not wait for it.",
      },
      false,
    );
    expect(running).toContain("◉ running in background");
    expect(running).toContain("/run b3ca589a");
    expect(running).not.toContain("End your turn");

    const failed = formatResultPreview(
      {
        details: {
          runId: "b3ca589a-0000",
          status: "failed",
          error: "agent exploded\nstack",
        },
        text: "<workflow-run …>",
      },
      false,
    );
    expect(failed).toContain("✗ failed — agent exploded stack");
    expect(failed).toContain("/run b3ca589a");
  });
});

describe("project trust", () => {
  const untrustedCtx = () =>
    ({
      cwd: projectDir,
      isProjectTrusted: () => false,
    }) as unknown as ExtensionContext;

  test("untrusted projects hide project agents and workflows", async () => {
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    // The echo agent only exists in the project; without trust it is invisible.
    await expect(
      tool.execute(
        "t-trust-1",
        { flow: { kind: "agent", name: "echo", task: "hi" } },
        undefined,
        undefined,
        untrustedCtx(),
      ),
    ).rejects.toThrow("unknown agent 'echo'");
    expect(specs).toHaveLength(0);
    await expect(
      tool.execute(
        "t-trust-2",
        { name: "greet", params: { target: "world" } },
        undefined,
        undefined,
        untrustedCtx(),
      ),
    ).rejects.toThrow("unknown workflow 'greet'");
  });

  test("explicit project scope is rejected when untrusted", async () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    await expect(
      tool.execute(
        "t-trust-3",
        {
          flow: { kind: "agent", name: "echo", task: "hi" },
          scope: "project",
        },
        undefined,
        undefined,
        untrustedCtx(),
      ),
    ).rejects.toThrow("not trusted");
  });

  test("per-node project scope overrides clamp to user when untrusted", async () => {
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    await expect(
      tool.execute(
        "t-trust-4",
        {
          flow: {
            kind: "agent",
            name: "echo",
            task: "hi",
            scope: "project",
          },
        },
        undefined,
        undefined,
        untrustedCtx(),
      ),
    ).rejects.toThrow("unknown agent 'echo'");
    expect(specs).toHaveLength(0);
  });
});

describe("parseCommandArgs", () => {
  const params = [{ name: "target", required: true }, { name: "depth" }];

  test("single-param workflows take the raw string", () => {
    const result = parseCommandArgs("src/core with spaces", [
      { name: "target" },
    ]);
    expect(result.values).toEqual({ target: "src/core with spaces" });
  });

  test("key=value and positional binding", () => {
    expect(parseCommandArgs("depth=deep src/", params).values).toEqual({
      depth: "deep",
      target: "src/",
    });
    expect(parseCommandArgs("src/ deep", params).values).toEqual({
      target: "src/",
      depth: "deep",
    });
    expect(parseCommandArgs('target="a b"', params).values).toEqual({
      target: "a b",
    });
  });

  test("unknown keys and extra positionals are errors", () => {
    expect(parseCommandArgs("bogus=1", params).errors[0]).toContain(
      "unknown parameter 'bogus'",
    );
    expect(parseCommandArgs("a b c", params).errors[0]).toContain(
      "too many positional",
    );
  });

  test("empty args yield no values", () => {
    expect(parseCommandArgs("  ", params)).toEqual({ values: {}, errors: [] });
  });
});
