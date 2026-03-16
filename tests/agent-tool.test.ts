import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type ChildProcessWithoutNullStreams,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import agentExtension, {
  createAgentExtension,
  type SpawnProcess,
} from "../extensions/agent/index.ts";
import type { AgentRunDetails } from "../extensions/agent/types.ts";

type ErrorWithDetails = Error & { details?: AgentRunDetails };

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

function setupTool(register = agentExtension) {
  let tool: ToolDefinition | undefined;

  const api = {
    registerCommand() {
      // not needed for tool tests
    },
    registerTool(registered: ToolDefinition) {
      if (registered.name === "agent") tool = registered;
    },
    sendMessage() {
      // not needed for tool tests
    },
    appendEntry() {
      // not needed for tool tests
    },
    on() {
      // not needed for tool tests
    },
    events: {
      emit() {
        // not needed for tool tests
      },
    },
  } as unknown as ExtensionAPI;

  register(api);

  if (!tool) throw new Error("agent tool was not registered");
  return tool;
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-agent-tool-test-"));
  workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-tool-workspace-"),
  );
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(sandboxDir, ".pi", "agent");
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("agent tool delegated process execution", () => {
  it("passes task text via stdin so leading dashes are treated as prompt content", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );
    let capturedArgs: string[] = [];
    let capturedInput = "";
    const spawnProcess: SpawnProcess = (_command, args) => {
      capturedArgs = [...args];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          capturedInput += chunk.toString();
          callback();
        },
      });
      const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
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
      queueMicrotask(() => {
        const event = {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
        };
        stdout.write(`${JSON.stringify(event)}\n`);
        proc.emit("close", 0);
      });
      return proc;
    };

    const tool = setupTool(createAgentExtension({ spawnProcess }));
    const result = await tool.execute(
      "call-1",
      { name: "explorer", task: "--help" },
      undefined,
      undefined,
      { cwd: workspaceDir } as unknown as ExtensionContext,
    );

    expect(result.isError).toBeFalsy();
    expect(capturedArgs).not.toContain("--");
    expect(capturedArgs).not.toContain("--help");
    expect(capturedInput).toBe("--help");
  });

  it("throws for unknown agent names so the tool result is marked as an error", async () => {
    const tool = setupTool();
    const error = (await tool
      .execute(
        "call-missing",
        { name: "missing", task: "do work" },
        undefined,
        undefined,
        { cwd: workspaceDir } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch(
        (caught) => caught as ErrorWithDetails,
      )) as ErrorWithDetails | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain('Unknown agent "missing"');
    expect(error?.details?.agent).toBe("missing");
    expect(error?.details?.discoveryDiagnostics).toEqual([]);
  });

  it("surfaces spawn errors with actionable diagnostics", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );
    const spawnProcess: SpawnProcess = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
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
      queueMicrotask(() => {
        proc.emit("error", new Error("spawn pi ENOENT"));
      });
      return proc;
    };

    const tool = setupTool(createAgentExtension({ spawnProcess }));
    const error = (await tool
      .execute(
        "call-2",
        { name: "explorer", task: "do work" },
        undefined,
        undefined,
        { cwd: workspaceDir } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch(
        (caught) => caught as ErrorWithDetails,
      )) as ErrorWithDetails | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain('Failed to spawn "pi"');
    const details = error?.details;
    expect(details?.errorMessage ?? "").toContain('Failed to spawn "pi"');
    expect(details?.stderr ?? "").toContain('Failed to spawn "pi"');
  });

  it("treats delegate processes terminated by signal as failures", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );
    const spawnProcess: SpawnProcess = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
      Object.assign(proc, {
        stdout,
        stderr,
        stdin,
        exitCode: null,
        signalCode: "SIGKILL",
        kill() {
          return true;
        },
      });
      queueMicrotask(() => {
        proc.emit("close", null, "SIGKILL");
      });
      return proc;
    };

    const tool = setupTool(createAgentExtension({ spawnProcess }));
    const error = (await tool
      .execute(
        "call-3",
        { name: "explorer", task: "do work" },
        undefined,
        undefined,
        { cwd: workspaceDir } as unknown as ExtensionContext,
      )
      .then(() => null)
      .catch(
        (caught) => caught as ErrorWithDetails,
      )) as ErrorWithDetails | null;

    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("terminated by signal SIGKILL");
    const details = error?.details;
    expect(details?.exitCode).toBe(1);
    expect(details?.stderr ?? "").toContain("terminated by signal SIGKILL");
  });
});
