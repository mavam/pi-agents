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
} from "@earendil-works/pi-coding-agent";
import agentExtension, {
  createAgentExtension,
  type SpawnProcess,
} from "../src/index.ts";
import type { AgentRunDetails } from "../src/runtime/types.ts";

type ErrorWithDetails = Error & { details?: AgentRunDetails };

let sandboxDir = "";
let workspaceDir = "";
let previousAgentDir: string | undefined;

function projectAgentsDir(): string {
  return path.join(workspaceDir, ".pi", "agents");
}

function writeAgent(
  filePath: string,
  name: string,
  description: string,
  options?: { model?: string; thinking?: string },
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      ...(options?.model ? [`model: ${options.model}`] : []),
      ...(options?.thinking ? [`thinking: ${options.thinking}`] : []),
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

function setupTool(
  register = agentExtension,
  options?: {
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  },
) {
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
    getThinkingLevel() {
      return options?.thinkingLevel ?? "off";
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
  it("does not surface a fake running placeholder before preview text exists", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Explorer",
    );

    const tool = setupTool(
      createAgentExtension({
        spawnProcess: (_command, _args, _options) => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let capturedInput = "";
          const stdin = new Writable({
            write(chunk, _encoding, callback) {
              capturedInput += chunk.toString();
              callback();
            },
            final(callback) {
              void capturedInput;
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "" }],
                  model: "anthropic/claude-sonnet-4-5",
                  usage: {
                    input_tokens: 1,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                  stop_reason: "end_turn",
                },
              };
              setTimeout(() => {
                stdout.write(`${JSON.stringify(event)}\n`);
                stdout.end();
                callback();
              }, 10);
            },
          });
          const child = new EventEmitter() as ChildProcessWithoutNullStreams;
          Object.assign(child, {
            stdout,
            stderr,
            stdin,
            pid: 123,
            exitCode: null,
            signalCode: null,
            kill: () => true,
          });
          setTimeout(() => child.emit("close", 0, null), 20);
          return child;
        },
      }),
    );

    const updates: AgentRunDetails[] = [];
    await tool.execute(
      "call-empty-preview",
      { name: "explorer", task: "Explore this repository" },
      undefined,
      (update) => {
        updates.push(update.details as AgentRunDetails);
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    expect(
      updates.some((details) => details.preview === "(running...)"),
    ).toBeFalse();
  });

  it("does not emit live tool updates when UI widgets are available", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Explorer",
    );

    const tool = setupTool(
      createAgentExtension({
        spawnProcess: (_command, _args, _options) => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let capturedInput = "";
          const stdin = new Writable({
            write(chunk, _encoding, callback) {
              capturedInput += chunk.toString();
              callback();
            },
            final(callback) {
              void capturedInput;
              const event = {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  model: "anthropic/claude-sonnet-4-5",
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                  stop_reason: "end_turn",
                },
              };
              setTimeout(() => {
                stdout.write(`${JSON.stringify(event)}\n`);
                stdout.end();
                callback();
              }, 10);
            },
          });
          const child = new EventEmitter() as ChildProcessWithoutNullStreams;
          Object.assign(child, {
            stdout,
            stderr,
            stdin,
            pid: 123,
            exitCode: null,
            signalCode: null,
            kill: () => true,
          });
          setTimeout(() => child.emit("close", 0, null), 20);
          return child;
        },
      }),
    );

    let updateCount = 0;
    const result = await tool.execute(
      "call-ui-agent",
      { name: "explorer", task: "Explore this repository" },
      undefined,
      () => {
        updateCount += 1;
      },
      { cwd: workspaceDir, hasUI: true } as unknown as ExtensionContext,
    );

    expect(updateCount).toBe(0);
    expect(result.details.agent).toBe("explorer");
    expect(result.details.status).toBe("background");
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Standing by for results.");
    }
  });
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

  it("inherits the current session model and thinking when the agent omits them", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );
    let capturedArgs: string[] = [];
    const spawnProcess: SpawnProcess = (_command, args) => {
      capturedArgs = [...args];
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

    const tool = setupTool(createAgentExtension({ spawnProcess }), {
      thinkingLevel: "high",
    });
    await tool.execute(
      "call-inherit",
      { name: "explorer", task: "do work" },
      undefined,
      undefined,
      {
        cwd: workspaceDir,
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
        },
      } as unknown as ExtensionContext,
    );

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("anthropic/claude-sonnet-4-5");
    expect(capturedArgs).toContain("--thinking");
    expect(capturedArgs).toContain("high");
  });

  it("resolves agent names case-insensitively when unambiguous", async () => {
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
      "call-case-insensitive",
      { name: "Explorer", task: "do work" },
      undefined,
      undefined,
      { cwd: workspaceDir } as unknown as ExtensionContext,
    );

    expect(result.isError).toBeFalsy();
    expect(result.details?.agent).toBe("explorer");
  });

  it("discovers agents relative to the delegated cwd", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );
    const otherCwd = mkdtempSync(
      path.join(os.tmpdir(), "pi-agent-tool-other-"),
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

    try {
      const tool = setupTool(createAgentExtension({ spawnProcess }));
      const result = await tool.execute(
        "call-cwd",
        { name: "explorer", task: "do work", cwd: workspaceDir },
        undefined,
        undefined,
        { cwd: otherCwd } as unknown as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0];
      expect(text?.type).toBe("text");
      expect(text?.text).toContain("<agent_result");
      expect(text?.text).toContain("ok");
      expect(text?.text).toContain("</agent_result>");
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
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
