import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  SpawnEngine,
  SpawnHandle,
  SpawnSpec,
} from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import { validateFlow } from "../../src/model/validate.js";
import { MAX_MODEL_RESULT_CHARS } from "../../src/model/value.js";
import { RunManager } from "../../src/run/runs.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import {
  createSteerTool,
  createWorkflowTool,
  FLOW_PARAM_DESCRIPTION,
  formatRunResult,
  type WorkflowToolParamsType,
  type WorkflowToolRenderState,
} from "../../src/triggers/tool.js";
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

type WorkflowTool = ReturnType<typeof createWorkflowTool>;
type RenderCallContext = Parameters<NonNullable<WorkflowTool["renderCall"]>>[2];

function renderCallContext(
  args: WorkflowToolParamsType,
  state: WorkflowToolRenderState,
  overrides: Partial<RenderCallContext> = {},
): RenderCallContext {
  return {
    args,
    toolCallId: "t-render",
    invalidate: () => {},
    lastComponent: undefined,
    state,
    cwd: projectDir,
    executionStarted: false,
    argsComplete: false,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

function renderedText(component: { render(width: number): string[] }): string {
  return component.render(120).join("\n");
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
            value: handler(spec),
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
            return { value: "ok", exitCode: 0, usage: emptyUsage() };
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
    'name: greet\ndescription: greets a target\ndisplay: report\nparams:\n  - name: target\n    required: true\nflow: { kind: agent, name: echo, task: "greet {params.target}" }\n',
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
    const deps = makeDeps(engine);
    const tool = createWorkflowTool(deps);
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
    expect(
      deps.manager.state.runs.get(result.details.runId)?.header.display,
    ).toBe("report");
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

  test("an anonymous inline node loads a skill and can drop its tools", async () => {
    writeFile(
      ".pi/skills/code-review/SKILL.md",
      "---\nname: code-review\ndescription: review code\n---\nRate findings by severity.\n",
    );
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t3-skills",
      {
        flow: {
          kind: "agent",
          task: "review the diff",
          skills: ["code-review"],
          tools: [],
        },
        scope: "project",
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(result.details.status).toBe("completed");
    expect(specs[0]?.agent).toBe("ad-hoc");
    expect(specs[0]?.systemPrompt).toContain("Rate findings by severity.");
    expect(specs[0]?.tools).toEqual([]);
  });

  test("a named node replaces its profile's tools and skills", async () => {
    writeFile(
      ".pi/skills/code-review/SKILL.md",
      "---\nname: code-review\ndescription: review code\n---\nRate findings by severity.\n",
    );
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    await tool.execute(
      "t3-replace",
      {
        flow: {
          kind: "agent",
          name: "reviewer",
          task: "review",
          skills: ["code-review"],
          tools: ["find"],
        },
        scope: "project",
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(specs[0]?.tools).toEqual(["find"]);
    expect(specs[0]?.systemPrompt).toContain("Review.");
    expect(specs[0]?.systemPrompt).toContain("Rate findings by severity.");
  });

  test("an unknown skill fails the run before anything spawns", async () => {
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    expect(
      tool.execute(
        "t3-missing",
        {
          flow: { kind: "agent", task: "t", skills: ["code-reveiw"] },
          scope: "project",
        },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow(/unknown skill 'code-reveiw'/);
    expect(specs).toHaveLength(0);
  });

  test("a saved flat workflow expresses the same skill selection", async () => {
    writeFile(
      ".pi/skills/code-review/SKILL.md",
      "---\nname: code-review\ndescription: review code\n---\nRate findings by severity.\n",
    );
    writeFile(
      ".pi/workflows/audit.yaml",
      'name: audit\ndescription: audits a target\ntask: "audit it"\nskills: [code-review]\ntools: []\n',
    );
    const { engine, specs } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t3-flat",
      { name: "audit", scope: "project" },
      undefined,
      undefined,
      ctx(),
    );
    expect(result.details.status).toBe("completed");
    expect(specs[0]?.systemPrompt).toContain("Rate findings by severity.");
    expect(specs[0]?.tools).toEqual([]);
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

  test("runs an anonymous leaf against a completely empty catalog", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-empty-"));
    try {
      const { engine, specs } = fakeEngine((spec) => `did: ${spec.task}`);
      const tool = createWorkflowTool(makeDeps(engine));
      const result = await tool.execute(
        "t-anon-1",
        {
          flow: { kind: "agent", task: "create a worktree" },
          scope: "both",
        },
        undefined,
        undefined,
        { cwd: emptyDir } as unknown as ExtensionContext,
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('status="completed"');
      expect(text).toContain("did: create a worktree");
      expect(specs[0]?.agent).toBe("ad-hoc");
      expect(specs[0]?.systemPrompt).toContain("result-submission mechanism"); // result contract only, no persona
      expect(specs[0]?.tools).toBeUndefined();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("runs sequence and parallel flows of only anonymous agents", async () => {
    const { engine, specs } = fakeEngine((spec) => `ok: ${spec.task}`);
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t-anon-2",
      {
        flow: {
          kind: "sequence",
          steps: [
            { kind: "agent", task: "scout", as: "map" },
            {
              kind: "parallel",
              branches: {
                a: { kind: "agent", task: "review A using {map}" },
                b: { kind: "agent", task: "review B using {map}" },
              },
              reduce: { task: "merge {branches}" },
            },
          ],
        },
        scope: "project",
      },
      undefined,
      undefined,
      ctx(),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('status="completed"');
    expect(specs).toHaveLength(4);
    expect(new Set(specs.map((spec) => spec.agent))).toEqual(
      new Set(["ad-hoc"]),
    );
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

  test("bounds oversized structured results entering model context", () => {
    const text = formatRunResult("run-structured", "review", {
      status: "completed",
      value: {
        branches: {
          review: `${"x".repeat(MAX_MODEL_RESULT_CHARS + 100)}complete-tail`,
        },
      },
      usage: emptyUsage(),
      agents: 2,
    });
    expect(text).toContain("[truncated");
    expect(text).toContain("full result: /workflow run-stru raw");
    expect(text).not.toContain("complete-tail");
  });

  test("RPC mode stays foreground even though pi exposes a UI bridge", async () => {
    const { engine } = fakeEngine(() => "nested result");
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t-rpc",
      { flow: { kind: "agent", name: "echo", task: "nested" } },
      undefined,
      undefined,
      {
        cwd: projectDir,
        mode: "rpc",
        hasUI: true,
      } as unknown as ExtensionContext,
    );
    expect(result.details.status).toBe("completed");
    expect((result.content[0] as { text: string }).text).toContain(
      "nested result",
    );
    expect(result.terminate).toBeUndefined();
  });
});

describe("steer tool", () => {
  test("resolves a run prefix, infers its sole instance, and queues once", async () => {
    const controlled = steerableEngine();
    const deps = makeDeps(controlled.engine);
    const started = deps.manager.start({
      flow: validateFlow({ kind: "agent", name: "echo", task: "wait" }),
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
    });
    await waitFor(
      () => deps.manager.steerableInstances(started.runId).length === 1,
    );

    const result = await createSteerTool(deps).execute(
      "steer-1",
      {
        run: started.runId.slice(0, 8),
        message: "  prioritize the regression  ",
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(controlled.messages).toEqual(["prioritize the regression"]);
    expect(result.details).toEqual({ runId: started.runId, instance: "$" });
    expect((result.content[0] as { text: string }).text).toContain(
      "Steering queued for $",
    );

    await expect(
      createSteerTool(deps).execute(
        "steer-2",
        { run: started.runId, instance: "$.missing", message: "try this" },
        undefined,
        undefined,
        ctx(),
      ),
    ).rejects.toThrow("is not steerable");

    controlled.finish();
    await started.done;
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
    expect(tree).toBe(
      ["❖ greet", "└─ ✦ echo · greet {params.target}"].join("\n"),
    );
    const preview = formatCallPreview(
      { name: "greet", params: { target: "world" } },
      undefined,
      tree,
    );
    expect(preview.split("\n")).toEqual([
      "❖ greet",
      "│  target: world",
      "└─ ✦ echo · greet {params.target}",
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

  test("anonymous inline leaves render as ad-hoc", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const preview = formatCallPreview({
      flow: { kind: "agent", task: "hello" },
      label: "Quick check",
    });
    expect(preview).toBe("Quick check\n✦ ad-hoc · hello");
    expect(preview).not.toContain("└─");
  });

  test("streaming previews retain the newest valid tree", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const state: WorkflowToolRenderState = {};
    const first = formatCallPreview(
      { flow: { kind: "agent", task: "first" } },
      undefined,
      undefined,
      state,
    );
    expect(first).toBe("✦ ad-hoc · first");

    const invalid = formatCallPreview(
      { flow: { kind: "paral" } },
      undefined,
      undefined,
      state,
    );
    expect(invalid).toBe(first);
    expect(invalid).not.toContain('{"kind":');

    const newest = formatCallPreview(
      { flow: { kind: "agent", task: "newest" } },
      undefined,
      undefined,
      state,
    );
    expect(newest).toBe("✦ ad-hoc · newest");
    expect(state.lastValidFlowTree).toBe(newest);
    expect(
      formatCallPreview(
        { flow: { kind: "agent", task: "newest", output: "" } },
        undefined,
        undefined,
        state,
      ),
    ).toBe(newest);
  });

  test("streaming previews suppress raw JSON until a tree is valid", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    expect(
      formatCallPreview({ flow: { kind: "paral" } }, undefined, undefined, {}),
    ).toBe("");
    expect(
      formatCallPreview(
        { flow: { kind: "paral" }, label: "Streaming" },
        undefined,
        undefined,
        {},
      ),
    ).toBe("Streaming");
  });

  test("completed invalid previews retain the diagnostic JSON", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const preview = formatCallPreview({ flow: { kind: "paral" } });
    expect(preview).toContain('{"kind":"paral"}');
  });

  test("streaming every argument prefix never regresses to raw JSON", async () => {
    const { formatCallPreview } = await import("../../src/triggers/tool.js");
    const completeArgs = {
      flow: {
        kind: "parallel",
        branches: {
          investigate: {
            kind: "agent",
            task: "Investigate the rendering lifecycle and flicker source",
          },
          reproduce: {
            kind: "sequence",
            steps: [
              {
                kind: "agent",
                task: "Build a minimal streaming reproduction",
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
                as: "case",
              },
              {
                kind: "agent",
                task: "Analyze {case} and propose regression checks",
              },
            ],
          },
        },
        onError: "collect",
        reduce: { task: "Synthesize {branches} into one recommendation" },
      },
      label: "Investigate workflow rendering flicker",
    } satisfies WorkflowToolParamsType;
    const json = JSON.stringify(completeArgs);
    const state: WorkflowToolRenderState = {};
    let previousLineCount = 0;

    for (let length = 1; length <= json.length; length++) {
      const args = parseStreamingJson<WorkflowToolParamsType>(
        json.slice(0, length),
      );
      const preview = formatCallPreview(args, undefined, undefined, state);
      expect(preview).not.toContain('{"kind":');
      if (state.lastValidFlowTree) {
        expect(preview).toContain(state.lastValidFlowTree);
        const lineCount = preview.split("\n").length;
        expect(lineCount).toBeGreaterThanOrEqual(previousLineCount);
        previousLineCount = lineCount;
      }
    }

    const completed = formatCallPreview(completeArgs);
    expect(formatCallPreview(completeArgs, undefined, undefined, state)).toBe(
      completed,
    );
  });

  test("renderCall keeps stable streaming frames on one Text component", () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    const renderCall = tool.renderCall as NonNullable<typeof tool.renderCall>;
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Parameters<typeof renderCall>[1];
    const state: WorkflowToolRenderState = {};
    const validArgs = { flow: { kind: "agent", task: "first" } };
    const first = renderCall(
      validArgs,
      theme,
      renderCallContext(validArgs, state),
    );
    if (!(first instanceof Text)) throw new Error("expected Text renderer");
    const stableText = renderedText(first);
    const setText = spyOn(first, "setText");

    const invalidArgs = { flow: { kind: "paral" } };
    const second = renderCall(
      invalidArgs,
      theme,
      renderCallContext(invalidArgs, state, { lastComponent: first }),
    );
    expect(second).toBe(first);
    expect(renderedText(second)).toBe(stableText);
    expect(setText).not.toHaveBeenCalled();

    const changedArgs = { flow: { kind: "agent", task: "newest" } };
    renderCall(
      changedArgs,
      theme,
      renderCallContext(changedArgs, state, { lastComponent: first }),
    );
    expect(setText).toHaveBeenCalledTimes(1);
    expect(renderedText(first)).toContain("✦ ad-hoc · newest");

    renderCall(
      invalidArgs,
      theme,
      renderCallContext(invalidArgs, state, {
        argsComplete: true,
        lastComponent: first,
      }),
    );
    expect(setText).toHaveBeenCalledTimes(2);
    expect(renderedText(first)).toContain('{"kind":"paral"}');
  });

  test("saved workflow previews cache within their renderer row", () => {
    const { engine } = fakeEngine(() => "ok");
    const tool = createWorkflowTool(makeDeps(engine));
    const renderCall = tool.renderCall as NonNullable<typeof tool.renderCall>;
    const theme = {
      fg: (_color: string, text: string) => text,
    } as Parameters<typeof renderCall>[1];
    const savedState: WorkflowToolRenderState = {};
    const savedArgs = { name: "greet" };
    const saved = renderCall(
      savedArgs,
      theme,
      renderCallContext(savedArgs, savedState, {
        argsComplete: true,
        toolCallId: "same-id",
      }),
    );
    expect(savedState.savedFlowTree).toBe(
      ["❖ greet", "└─ ✦ echo · greet {params.target}"].join("\n"),
    );
    expect(renderedText(saved)).toContain("└─ ✦ echo · greet {params.target}");

    const missingState: WorkflowToolRenderState = {};
    const missingArgs = { name: "missing" };
    const missing = renderCall(
      missingArgs,
      theme,
      renderCallContext(missingArgs, missingState, {
        argsComplete: true,
        toolCallId: "same-id",
      }),
    );
    expect(missingState.savedFlowTree).toBeNull();
    expect(renderedText(missing)).toContain("❖ missing");
    expect(renderedText(missing)).not.toContain("✦ echo");
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
    // Blank-line separated from the tree, icon-less and dim while live.
    expect(running.startsWith("\n")).toBe(true);
    expect(running).toContain("running in background · /workflow b3ca589a");
    expect(running).not.toContain("◉");
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
    expect(failed).toContain("/workflow b3ca589a");
  });
});

describe("live result rendering", () => {
  test("renderResult reflects the run's current status, not the frozen result", async () => {
    const { engine } = fakeEngine(() => "all done");
    const deps = makeDeps(engine);
    const tool = createWorkflowTool(deps);
    const uiCtx = {
      cwd: projectDir,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      sessionManager: {
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
      ui: { setWidget: () => {} },
    } as unknown as ExtensionContext;
    const result = await tool.execute(
      "t-live",
      { flow: { kind: "agent", name: "echo", task: "hi" }, scope: "project" },
      undefined,
      undefined,
      uiCtx,
    );
    // Backgrounded: the stored result says running.
    expect(result.details.status).toBe("running");
    // Wait for the run to finish, then render with a marker theme.
    const start = Date.now();
    while (
      deps.manager.state.runs.get(result.details.runId)?.status === "running"
    ) {
      if (Date.now() - start > 2000) throw new Error("timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const theme = {
      fg: (_c: string, t: string) => t,
    } as unknown as Parameters<NonNullable<typeof tool.renderResult>>[2];
    const component = tool.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );
    const rendered = (component as { render: (w: number) => string[] })
      .render(120)
      .join("\n");
    expect(rendered).toContain("● completed");
    expect(rendered).not.toContain("running in background");
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

  test("untrusted projects can run purely anonymous inline flows", async () => {
    const { engine, specs } = fakeEngine((spec) => `ok: ${spec.task}`);
    const tool = createWorkflowTool(makeDeps(engine));
    const result = await tool.execute(
      "t-trust-anon",
      {
        flow: {
          kind: "parallel",
          branches: {
            a: { kind: "agent", task: "review A" },
            b: { kind: "agent", task: "review B" },
          },
          reduce: { task: "merge {branches}" },
        },
      },
      undefined,
      undefined,
      untrustedCtx(),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('status="completed"');
    expect(specs).toHaveLength(3);
    expect(new Set(specs.map((spec) => spec.agent))).toEqual(
      new Set(["ad-hoc"]),
    );
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

describe("workflow tool description", () => {
  const inertEngine = {
    spawn: () => {
      throw new Error("not used");
    },
  } as unknown as SpawnEngine;

  /** A grammar fragment that appears only inside the node reference. */
  const GRAMMAR_MARKER = '{"kind":"parallel","branches"';

  /** Match a needle inside JSON.stringify output, where quotes are escaped. */
  function escaped(needle: string): string {
    return JSON.stringify(needle).slice(1, -1);
  }

  test("the node grammar appears exactly once in the tool definition", () => {
    const tool = createWorkflowTool(makeDeps(inertEngine));
    const serialized = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters,
    });
    expect(serialized.split(escaped(GRAMMAR_MARKER)).length - 1).toBe(1);
    expect(JSON.stringify(tool.parameters)).toContain(
      escaped(FLOW_PARAM_DESCRIPTION),
    );
  });

  test("the budget schema advertises ranges, defaults, and units", () => {
    const tool = createWorkflowTool(makeDeps(inertEngine));
    const schema = tool.parameters as unknown as {
      properties: {
        budgets: {
          properties: Record<
            string,
            {
              type: string;
              minimum?: number;
              exclusiveMinimum?: number;
              description?: string;
            }
          >;
        };
      };
    };
    const budgets = schema.properties.budgets.properties;
    expect(budgets.maxAgents).toMatchObject({ type: "integer", minimum: 0 });
    expect(budgets.maxAgents?.description).toContain(
      "Zero prohibits agent execution",
    );
    expect(budgets.maxAgents?.description).toContain("default 50");

    for (const [name, defaultValue] of [
      ["maxDepth", 5],
      ["maxParallelism", 8],
      ["maxIterations", 10],
      ["maxTurns", 250],
    ] as const) {
      expect(budgets[name]).toMatchObject({ type: "integer", minimum: 1 });
      expect(budgets[name]?.description).toContain(`default ${defaultValue}`);
    }
    expect(budgets.maxTokens).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    for (const name of [
      "maxAgentDuration",
      "maxDuration",
      "maxCost",
    ] as const) {
      expect(budgets[name]).toMatchObject({
        type: "number",
        exclusiveMinimum: 0,
      });
    }
  });

  test("the description covers every node kind and the binding rules", () => {
    const tool = createWorkflowTool(makeDeps(inertEngine));
    for (const kind of [
      "agent",
      "sequence",
      "parallel",
      "map",
      "loop",
      "while",
      "switch",
      "value",
      "workflow",
    ]) {
      expect(tool.description).toContain(`"kind":"${kind}"`);
    }
    expect(tool.description).toContain("{previous}");
    expect(tool.description).toContain("{current}");
    expect(tool.description).toContain('"as"');
    expect(tool.description).toContain(
      '"model":"provider/id from <models> (bare id resolves to the earliest listed provider)"',
    );
    expect(
      tool.promptGuidelines?.some((line) =>
        line.includes("An unknown model fails the run before anything spawns"),
      ),
    ).toBe(true);
  });

  test("the description gates the tool on an explicit request", () => {
    const tool = createWorkflowTool(makeDeps(inertEngine));
    expect(tool.description).toContain("USE ONLY ON EXPLICIT REQUEST");
    expect(tool.description).toContain("opt-in");
    // The near-misses that produce unwanted runs must be named, not implied.
    expect(tool.description).toContain("Nothing else is a trigger");
    // Mentioning the word is not a request — the hole that matters most in a
    // repo whose every conversation says "workflow".
    expect(tool.description).toContain(
      'Mentioning "workflow" or "flow" is not',
    );
    // The tool cannot touch an existing run, so it must not invite the attempt.
    expect(tool.description).toContain("never call this tool");
    expect(tool.promptSnippet).toContain("explicitly");
    const guidelines = tool.promptGuidelines ?? [];
    expect(guidelines[0]).toContain("Do not call `workflow` unless");
    expect(guidelines.some((line) => line.includes("are not triggers"))).toBe(
      true,
    );
    expect(
      guidelines.some((line) => line.includes("only starts new runs")),
    ).toBe(true);
  });
});
