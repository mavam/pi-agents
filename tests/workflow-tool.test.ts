import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentExtension,
  type SpawnProcess,
} from "../extensions/agent/index.ts";
import type { RunResultDetails } from "../extensions/agent/types.ts";

let sandboxDir = "";
let workspaceDir = "";
let previousAgentDir: string | undefined;

function projectAgentsDir(): string {
  return path.join(workspaceDir, ".pi", "agents");
}

function writeAgent(filePath: string, name: string, description: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "model: openai-codex/gpt-5.3-codex-spark",
      "thinking: low",
      "skills:",
      "  - search",
      "---",
      "",
      "Run delegated work.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function setupWorkflowTool(
  spawnProcess: SpawnProcess,
  options?: {
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  },
): ToolDefinition {
  let tool: ToolDefinition | undefined;

  createAgentExtension({ spawnProcess })({
    registerCommand() {
      // not needed
    },
    registerTool(registered: ToolDefinition) {
      if (registered.name === "workflow") tool = registered;
    },
    sendMessage() {
      // not needed
    },
    on() {
      // not needed
    },
    appendEntry() {
      // not needed
    },
    getThinkingLevel() {
      return options?.thinkingLevel ?? "off";
    },
    events: {
      emit() {
        // not needed
      },
    },
  } as unknown as ExtensionAPI);

  if (!tool) throw new Error("workflow tool was not registered");
  return tool;
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-workflow-test-"));
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), "pi-workflow-workspace-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(sandboxDir, ".pi", "agent");
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

function createSpawnProcess(
  handler: (input: string) => string,
  inputs: string[],
): SpawnProcess {
  return (_command, _args, _options) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let capturedInput = "";
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        capturedInput += chunk.toString();
        callback();
      },
      final(callback) {
        inputs.push(capturedInput);
        const event = {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: handler(capturedInput) }],
            usage: {
              input: 1,
              output: 1,
              totalTokens: 2,
              cost: { total: 0 },
            },
          },
        };
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify(event)}\n`);
          proc.emit("close", 0, null);
        });
        callback();
      },
    });
    const proc =
      new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(proc, {
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
    });
    return proc;
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for background work.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("workflow tool", () => {
  it("exposes a structured flow schema to tool callers", () => {
    const tool = setupWorkflowTool(createSpawnProcess(() => "ok", []));
    const serialized = JSON.stringify(tool.parameters);

    expect(serialized).toContain('"required":["flow"]');
    expect(serialized).toContain('"const":"spawn"');
    expect(serialized).toContain('"const":"sequence"');
    expect(serialized).toContain('"const":"fork"');
    expect(serialized).toContain('"const":"join"');
    expect(serialized).toContain('"const":"loop"');
  });

  it("resolves workflow agent names case-insensitively when unambiguous", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    const tool = setupWorkflowTool(createSpawnProcess(() => "ok", inputs));

    const result = await tool.execute(
      "call-case-insensitive-workflow",
      {
        flow: {
          kind: "spawn",
          agent: "Reviewer",
          task: "first step",
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(result.content[0]?.type).toBe("text");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("first step");
  });

  it("rejects invalid workflow agents before any child runs start", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    const tool = setupWorkflowTool(createSpawnProcess(() => "alpha", inputs));

    const error = (await tool
      .execute(
        "call-preflight-invalid-agent",
        {
          flow: {
            kind: "sequence",
            steps: [
              {
                kind: "spawn",
                agent: "reviewer",
                task: "first step",
              },
              {
                kind: "spawn",
                agent: "missing",
                task: "second step",
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("Unknown workflow agents");
    expect(error?.message ?? "").toContain('flow.steps[1].agent: "missing"');
    expect(inputs).toEqual([]);
  });

  it("accepts top-level spawn shorthand without kind", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    const tool = setupWorkflowTool(createSpawnProcess(() => "alpha", inputs));

    const result = await tool.execute(
      "call-shorthand-spawn",
      {
        flow: {
          agent: "reviewer",
          task: "first step",
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(result.content[0]?.type).toBe("text");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("first step");
  });

  it("expands fork shorthands with inherited defaults", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const inputs: string[] = [];
    const tool = setupWorkflowTool(
      createSpawnProcess((input) => {
        if (input.includes("architecture")) return "arch";
        if (input.includes("tests")) return "tests";
        return "other";
      }, inputs),
    );

    const result = await tool.execute(
      "call-shorthand-fork",
      {
        label: "Two-Lens Review",
        flow: {
          kind: "fork",
          id: "fanout",
          agent: "worker",
          taskTemplate: "Review from the {branch} lens.",
          branches: {
            architecture: {},
            tests: "worker",
          },
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    expect(details.result?.output.branches.architecture).toBe("arch");
    expect(details.result?.output.branches.tests).toBe("tests");
    expect(inputs).toHaveLength(2);
    expect(
      inputs.some((input) =>
        input.includes("Review from the architecture lens."),
      ),
    ).toBe(true);
    expect(
      inputs.some((input) => input.includes("Review from the tests lens.")),
    ).toBe(true);
  });

  it("passes prior sequence results as workflow context", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("second step")) return "beta";
      return "alpha";
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-1",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "spawn",
              id: "first",
              agent: "reviewer",
              task: "first step",
            },
            {
              kind: "spawn",
              id: "second",
              agent: "reviewer",
              task: "second step",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(result.content[0]?.type).toBe("text");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Workflow context from prior completed steps");
    expect(inputs[1]).toContain("alpha");
  });

  it("truncates workflow context before passing it downstream", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const hugeOutput = "alpha".repeat(5_000);
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("second step")) return "beta";
      return hugeOutput;
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    await tool.execute(
      "call-context-truncation",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "spawn",
              id: "first",
              agent: "reviewer",
              task: "first step",
            },
            {
              kind: "spawn",
              id: "second",
              agent: "reviewer",
              task: "second step",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Workflow context from prior completed steps");
    expect(inputs[1].length).toBeLessThan(12_500);
    expect(inputs[1]).toContain("more chars");
  });

  it("collects fork results through join", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("branch A")) return "result-a";
      if (input.includes("branch B")) return "result-b";
      return "unknown";
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-2",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "fork",
              id: "fanout",
              branches: {
                a: { kind: "spawn", agent: "worker", task: "branch A" },
                b: { kind: "spawn", agent: "worker", task: "branch B" },
              },
            },
            {
              kind: "join",
              from: "fanout",
              mode: "all",
              reducer: { kind: "collect" },
              onFailure: "collectErrors",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    expect(details.result.output.branches.a).toBe("result-a");
    expect(details.result.output.branches.b).toBe("result-b");
  });

  it("delegates fork summarization to an agent reducer in join", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    writeAgent(
      path.join(projectAgentsDir(), "summarizer.md"),
      "summarizer",
      "Summarizer",
    );
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("branch A")) return "result-a";
      if (input.includes("branch B")) return "result-b";
      if (input.includes("Summarize")) return "combined summary";
      return "unknown";
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-reducer",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "fork",
              id: "fanout",
              branches: {
                a: { kind: "spawn", agent: "worker", task: "branch A" },
                b: { kind: "spawn", agent: "worker", task: "branch B" },
              },
            },
            {
              kind: "join",
              from: "fanout",
              mode: "all",
              reducer: {
                kind: "agent",
                agent: "summarizer",
                task: "Summarize the branch results.",
              },
              onFailure: "collectErrors",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    // The reducer agent should have received the join inputs.
    const reducerInput = inputs.find((i) => i.includes("Summarize"));
    expect(reducerInput).toBeDefined();
    expect(reducerInput).toContain("result-a");
    expect(reducerInput).toContain("result-b");
    // The join output should be the reducer agent's response.
    expect(details.result?.output).toBe("combined summary");
  });

  it("short-circuits join(any) after the first successful branch", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    let branchBKillCount = 0;
    let branchCStarts = 0;

    const spawnProcess: SpawnProcess = (_command, _args, _options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let capturedInput = "";
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          capturedInput += chunk.toString();
          callback();
        },
        final(callback) {
          queueMicrotask(() => {
            if (capturedInput.includes("branch A")) {
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-a" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
              return;
            }
            if (capturedInput.includes("branch B")) {
              return;
            }
            if (capturedInput.includes("branch C")) {
              branchCStarts += 1;
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-c" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
            }
          });
          callback();
        },
      });
      const proc =
        new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      Object.assign(proc, {
        stdout,
        stderr,
        stdin,
        exitCode: null,
        signalCode: null,
        kill(signal?: NodeJS.Signals) {
          if (capturedInput.includes("branch B")) {
            branchBKillCount += 1;
          }
          queueMicrotask(() => {
            proc.emit("close", null, signal ?? "SIGTERM");
          });
          return true;
        },
      });
      return proc;
    };

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-any-short-circuit",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "fork",
              id: "fanout",
              concurrency: 2,
              branches: {
                a: { kind: "spawn", agent: "worker", task: "branch A" },
                b: { kind: "spawn", agent: "worker", task: "branch B" },
                c: { kind: "spawn", agent: "worker", task: "branch C" },
              },
            },
            {
              kind: "join",
              from: "fanout",
              mode: "any",
              onFailure: "collectErrors",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    expect(details.result?.output.branches.a).toBe("result-a");
    expect(details.result?.output.errors).toEqual({});
    expect(branchBKillCount).toBeGreaterThan(0);
    expect(branchCStarts).toBe(0);
  });

  it("short-circuits join(quorum) once the quorum is met", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    let branchCKillCount = 0;
    let branchDStarts = 0;

    const spawnProcess: SpawnProcess = (_command, _args, _options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let capturedInput = "";
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          capturedInput += chunk.toString();
          callback();
        },
        final(callback) {
          queueMicrotask(() => {
            if (capturedInput.includes("branch A")) {
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-a" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
              return;
            }
            if (capturedInput.includes("branch B")) {
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-b" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
              return;
            }
            if (capturedInput.includes("branch C")) {
              return;
            }
            if (capturedInput.includes("branch D")) {
              branchDStarts += 1;
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-d" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
            }
          });
          callback();
        },
      });
      const proc =
        new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      Object.assign(proc, {
        stdout,
        stderr,
        stdin,
        exitCode: null,
        signalCode: null,
        kill(signal?: NodeJS.Signals) {
          if (capturedInput.includes("branch C")) {
            branchCKillCount += 1;
          }
          queueMicrotask(() => {
            proc.emit("close", null, signal ?? "SIGTERM");
          });
          return true;
        },
      });
      return proc;
    };

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-quorum-short-circuit",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "fork",
              id: "fanout",
              concurrency: 3,
              branches: {
                a: { kind: "spawn", agent: "worker", task: "branch A" },
                b: { kind: "spawn", agent: "worker", task: "branch B" },
                c: { kind: "spawn", agent: "worker", task: "branch C" },
                d: { kind: "spawn", agent: "worker", task: "branch D" },
              },
            },
            {
              kind: "join",
              from: "fanout",
              mode: "quorum",
              quorum: 2,
              onFailure: "collectErrors",
            },
          ],
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    expect(details.result?.output.branches.a).toBe("result-a");
    expect(details.result?.output.branches.b).toBe("result-b");
    expect(details.result?.output.errors).toEqual({});
    expect(branchCKillCount).toBeGreaterThan(0);
    expect(branchDStarts).toBe(0);
  });

  it("rejects multiple joins for the same fork", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const workflowTool = setupWorkflowTool(
      createSpawnProcess(() => "ok", inputs),
    );

    const error = (await workflowTool
      .execute(
        "call-duplicate-join",
        {
          flow: {
            kind: "sequence",
            steps: [
              {
                kind: "fork",
                id: "fanout",
                branches: {
                  a: { kind: "spawn", agent: "worker", task: "first" },
                },
              },
              { kind: "join", from: "fanout", mode: "all" },
              { kind: "join", from: "fanout", mode: "all" },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("already joined");
    expect(inputs).toEqual([]);
  });

  it("rejects joins that reference future forks", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const workflowTool = setupWorkflowTool(
      createSpawnProcess(() => "ok", inputs),
    );

    const error = (await workflowTool
      .execute(
        "call-forward-join",
        {
          flow: {
            kind: "sequence",
            steps: [
              { kind: "join", from: "fanout", mode: "all" },
              {
                kind: "fork",
                id: "fanout",
                branches: {
                  a: { kind: "spawn", agent: "worker", task: "first" },
                },
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("already available in this scope");
    expect(inputs).toEqual([]);
  });

  it("rejects joins that reference out-of-scope forks", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const workflowTool = setupWorkflowTool(
      createSpawnProcess(() => "ok", inputs),
    );

    const error = (await workflowTool
      .execute(
        "call-out-of-scope-join",
        {
          flow: {
            kind: "sequence",
            steps: [
              {
                kind: "sequence",
                steps: [
                  {
                    kind: "fork",
                    id: "inner-fanout",
                    branches: {
                      a: { kind: "spawn", agent: "worker", task: "first" },
                    },
                  },
                ],
              },
              { kind: "join", from: "inner-fanout", mode: "all" },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("inside a different scope");
    expect(inputs).toEqual([]);
  });

  it("rejects duplicate workflow node ids", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const workflowTool = setupWorkflowTool(
      createSpawnProcess(() => "ok", inputs),
    );

    const error = (await workflowTool
      .execute(
        "call-duplicate-id",
        {
          flow: {
            kind: "sequence",
            steps: [
              { kind: "spawn", id: "dup", agent: "worker", task: "first" },
              { kind: "spawn", id: "dup", agent: "worker", task: "second" },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain('duplicates "dup"');
    expect(inputs).toEqual([]);
  });

  it("rejects joins that do not reference a fork", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const workflowTool = setupWorkflowTool(
      createSpawnProcess(() => "ok", inputs),
    );

    const error = (await workflowTool
      .execute(
        "call-invalid-join",
        {
          flow: {
            kind: "sequence",
            steps: [
              {
                kind: "spawn",
                id: "not-a-fork",
                agent: "worker",
                task: "first",
              },
              { kind: "join", from: "not-a-fork", mode: "all" },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error)) as Error | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("must reference a fork node");
    expect(inputs).toEqual([]);
  });

  it("detaches and lets later sequence steps continue after interruption", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("first step")) return "alpha";
      return "beta";
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    const controller = new AbortController();
    let aborted = false;

    const result = await tool.execute(
      "call-cancel",
      {
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "spawn",
              id: "first",
              agent: "reviewer",
              task: "first step",
            },
            {
              kind: "spawn",
              id: "second",
              agent: "reviewer",
              task: "second step",
            },
          ],
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (
          !aborted &&
          details.nodes.some(
            (node) => node.kind === "spawn" && node.status === "completed",
          )
        ) {
          aborted = true;
          controller.abort();
        }
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(result.details.run.status).toBe("running");
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Flow detached");
    }
    await waitFor(() => inputs.length === 2);
  });

  it("stops looping when continueWhen no longer matches", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "reviewer.md"),
      "reviewer",
      "Reviewer",
    );
    const inputs: string[] = [];
    let count = 0;
    const spawnProcess = createSpawnProcess(() => {
      count += 1;
      return JSON.stringify({ done: count >= 2, round: count });
    }, inputs);

    const tool = setupWorkflowTool(spawnProcess);
    const result = await tool.execute(
      "call-3",
      {
        flow: {
          kind: "loop",
          id: "review-loop",
          maxIterations: 5,
          continueWhen: {
            kind: "result_field",
            path: "done",
            equals: false,
          },
          body: {
            kind: "spawn",
            id: "review",
            agent: "reviewer",
            task: "return review json",
            output: "json",
          },
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const details = result.details as RunResultDetails;
    expect(details.result.iterations).toHaveLength(2);
    expect(details.result.output.done).toBe(true);
  });

  it("aborts running siblings and stops scheduling new branches on failFast", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    let branchBKillCount = 0;
    let branchCStarts = 0;

    const spawnProcess: SpawnProcess = (_command, _args, _options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let capturedInput = "";
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          capturedInput += chunk.toString();
          callback();
        },
        final(callback) {
          queueMicrotask(() => {
            if (capturedInput.includes("branch A")) {
              stderr.write("branch A failed");
              proc.emit("close", 1, null);
              return;
            }
            if (capturedInput.includes("branch B")) {
              return;
            }
            if (capturedInput.includes("branch C")) {
              branchCStarts += 1;
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "result-c" }],
                },
              };
              stdout.write(`${JSON.stringify(event)}\n`);
              proc.emit("close", 0, null);
            }
          });
          callback();
        },
      });
      const proc =
        new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      Object.assign(proc, {
        stdout,
        stderr,
        stdin,
        exitCode: null,
        signalCode: null,
        kill(signal?: NodeJS.Signals) {
          if (capturedInput.includes("branch B")) {
            branchBKillCount += 1;
          }
          queueMicrotask(() => {
            proc.emit("close", null, signal ?? "SIGTERM");
          });
          return true;
        },
      });
      return proc;
    };

    const tool = setupWorkflowTool(spawnProcess);
    const error = await tool
      .execute(
        "call-fail-fast",
        {
          flow: {
            kind: "sequence",
            steps: [
              {
                kind: "fork",
                id: "fanout",
                concurrency: 2,
                branches: {
                  a: { kind: "spawn", agent: "worker", task: "branch A" },
                  b: { kind: "spawn", agent: "worker", task: "branch B" },
                  c: { kind: "spawn", agent: "worker", task: "branch C" },
                },
              },
              {
                kind: "join",
                from: "fanout",
                mode: "all",
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error);

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("branch A failed");
    expect(branchBKillCount).toBeGreaterThan(0);
    expect(branchCStarts).toBe(0);
  });

  it("detaches after startup even if interrupted before child agents begin", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    let spawnCount = 0;
    const spawnProcess: SpawnProcess = (...args) => {
      spawnCount += 1;
      return createSpawnProcess(() => "ok", [])(...args);
    };

    const tool = setupWorkflowTool(spawnProcess);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());

    const result = await tool.execute(
      "call-pre-abort",
      {
        flow: {
          kind: "spawn",
          id: "only",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(result.details.run.status).toBe("running");
    await waitFor(() => spawnCount === 1);
  });

  it("still aborts immediately when the caller signal is already aborted", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    let spawnCount = 0;
    const spawnProcess: SpawnProcess = (...args) => {
      spawnCount += 1;
      return createSpawnProcess(() => "ok", [])(...args);
    };

    const tool = setupWorkflowTool(spawnProcess);
    const controller = new AbortController();
    controller.abort();

    const error = await tool
      .execute(
        "call-already-aborted",
        {
          flow: {
            kind: "spawn",
            id: "only",
            agent: "worker",
            task: "do work",
          },
        },
        controller.signal,
        undefined,
        { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch((caught) => caught as Error);

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("Workflow aborted");
    expect(spawnCount).toBe(0);
  });

  it("emits immutable run snapshots to workflow observers", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const inputs: string[] = [];
    const tool = setupWorkflowTool(createSpawnProcess(() => "done", inputs));
    const snapshots: RunResultDetails[] = [];

    await tool.execute(
      "call-snapshots",
      {
        flow: {
          kind: "spawn",
          id: "only",
          agent: "worker",
          task: "do work",
        },
      },
      undefined,
      (update) => {
        snapshots.push(update.details as RunResultDetails);
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]?.run.status).toBe("running");
    expect(snapshots[0]?.result).toBeUndefined();
  });
});
