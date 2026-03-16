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

interface CapturedMessage {
  customType: string;
  content: string;
  display: boolean;
}

interface RegisteredCommand {
  handler: (args: string, ctx: { cwd: string }) => Promise<void>;
}

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
      "Explore quickly.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

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

function setupExtension(spawnProcess: SpawnProcess): {
  runsCommand: RegisteredCommand;
  runCommand: RegisteredCommand;
  agentTool: ToolDefinition;
  workflowTool: ToolDefinition;
  messages: CapturedMessage[];
} {
  const commands = new Map<string, RegisteredCommand>();
  const messages: CapturedMessage[] = [];
  let agentTool: ToolDefinition | undefined;
  let workflowTool: ToolDefinition | undefined;

  createAgentExtension({ spawnProcess })({
    registerCommand(name, options) {
      commands.set(name, options as RegisteredCommand);
    },
    registerTool(tool) {
      if (tool.name === "agent") agentTool = tool;
      if (tool.name === "workflow") workflowTool = tool;
    },
    sendMessage(message) {
      messages.push(message as CapturedMessage);
    },
    on() {
      // not needed in tests
    },
    appendEntry() {
      // not needed in tests
    },
    getThinkingLevel() {
      return "off";
    },
    events: {
      emit() {
        // not needed in tests
      },
    },
  } as unknown as ExtensionAPI);

  const runsCommand = commands.get("runs");
  if (!runsCommand) throw new Error("/runs command was not registered");

  const runCommand = commands.get("run");
  if (!runCommand) throw new Error("/run command was not registered");

  if (!agentTool) throw new Error("agent tool was not registered");
  if (!workflowTool) throw new Error("workflow tool was not registered");
  return { runsCommand, runCommand, agentTool, workflowTool, messages };
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-runs-cmd-test-"));
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), "pi-runs-cmd-workspace-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(sandboxDir, ".pi", "agent");
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("/runs command", () => {
  it("reports an empty run list before any runs exist", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { runsCommand, messages } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );
    await runsCommand.handler("", { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("No runs recorded in this session.");
  });
});

describe("/run command", () => {
  it("resolves unique run ID prefixes shown in the overview", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { runCommand, workflowTool, messages } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    const workflowResult = await workflowTool.execute(
      "call-1",
      {
        flow: {
          kind: "spawn",
          id: "first",
          agent: "explorer",
          task: "inspect",
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const runId = workflowResult.details.run.id as string;
    const prefix = runId.slice(0, 8);

    messages.length = 0;
    await runCommand.handler(prefix, { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain(`ID: ${runId}`);
    expect(messages[0]?.content).not.toContain("Unknown run");
  });

  it("lists direct agent tool executions as runs", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { agentTool, runsCommand, messages } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    await agentTool.execute(
      "call-agent-1",
      { name: "explorer", task: "inspect" },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    messages.length = 0;
    await runsCommand.handler("", { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("explorer");
    expect(messages[0]?.content).toContain("completed");
  });
});
