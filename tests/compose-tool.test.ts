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
import type { CompositionResultDetails } from "../extensions/agent/types.ts";

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

function setupComposeTool(spawnProcess: SpawnProcess): ToolDefinition {
  let tool: ToolDefinition | undefined;

  createAgentExtension({ spawnProcess })({
    registerCommand() {
      // not needed
    },
    registerTool(registered: ToolDefinition) {
      if (registered.name === "compose") tool = registered;
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
    events: {
      emit() {
        // not needed
      },
    },
  } as unknown as ExtensionAPI);

  if (!tool) throw new Error("compose tool was not registered");
  return tool;
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-compose-test-"));
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), "pi-compose-workspace-"));
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

describe("compose tool", () => {
  it("passes prior sequence results as composition context", async () => {
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

    const tool = setupComposeTool(spawnProcess);
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
    expect(inputs[1]).toContain(
      "Composition context from prior completed steps",
    );
    expect(inputs[1]).toContain("alpha");
  });

  it("collects fork results through join", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const inputs: string[] = [];
    const spawnProcess = createSpawnProcess((input) => {
      if (input.includes("branch A")) return "result-a";
      if (input.includes("branch B")) return "result-b";
      return "unknown";
    }, inputs);

    const tool = setupComposeTool(spawnProcess);
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

    const details = result.details as CompositionResultDetails;
    expect(details.result.output.branches.a).toBe("result-a");
    expect(details.result.output.branches.b).toBe("result-b");
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

    const tool = setupComposeTool(spawnProcess);
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

    const details = result.details as CompositionResultDetails;
    expect(details.result.iterations).toHaveLength(2);
    expect(details.result.output.done).toBe(true);
  });
});
