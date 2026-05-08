import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAgentExtension, type SpawnProcess } from "../src/index.ts";
import type { RunResultDetails } from "../src/runtime/types.ts";

interface CapturedMessage {
  customType: string;
  content: string;
  display: boolean;
}

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
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

function createLongRunningSpawnProcess(inputs: string[]): SpawnProcess {
  return (_command, _args, _options) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let capturedInput = "";
    let proc: ChildProcessWithoutNullStreams;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        capturedInput += chunk.toString();
        callback();
      },
      final(callback) {
        inputs.push(capturedInput);
        callback();
      },
    });
    proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(proc, {
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals) {
        queueMicrotask(() => {
          proc.emit("close", null, signal ?? "SIGTERM");
        });
        return true;
      },
    });
    return proc;
  };
}

function createDeferredSpawnProcess(inputs: string[]): {
  spawnProcess: SpawnProcess;
  finish: (output: string) => void;
} {
  let complete: ((output: string) => void) | undefined;

  return {
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
          inputs.push(capturedInput);
          complete = (output: string) => {
            const event = {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: output }],
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
          };
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
    },
    finish(output: string) {
      if (!complete) {
        throw new Error("No deferred spawn is waiting to finish.");
      }
      const resolve = complete;
      complete = undefined;
      resolve(output);
    },
  };
}

function createProgressingSpawnProcess(
  inputs: string[],
  progress: string,
): SpawnProcess {
  return (_command, _args, _options) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let capturedInput = "";
    let proc: ChildProcessWithoutNullStreams;
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
            content: [{ type: "text", text: progress }],
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
        });
        callback();
      },
    });
    proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(proc, {
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals) {
        queueMicrotask(() => {
          proc.emit("close", null, signal ?? "SIGTERM");
        });
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
      throw new Error("Timed out waiting for run state change.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setupExtension(spawnProcess: SpawnProcess): {
  flowsCommand: RegisteredCommand;
  flowCommand: RegisteredCommand;
  agentTool: ToolDefinition;
  workflowTool: ToolDefinition;
  messages: CapturedMessage[];
  appendEntries: Array<{ customType: string; data: unknown }>;
  ui: {
    selectChoices: string[];
    customInputs: string[][];
    customCalls: number;
    customRenders: string[];
    context: ExtensionContext["ui"];
  };
  events: Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  >;
} {
  const commands = new Map<string, RegisteredCommand>();
  const messages: CapturedMessage[] = [];
  const appendEntries: Array<{ customType: string; data: unknown }> = [];
  const events = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void> | void
  >();
  let agentTool: ToolDefinition | undefined;
  let workflowTool: ToolDefinition | undefined;
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  } as unknown as Theme;
  const uiHarness = {
    selectChoices: [] as string[],
    customInputs: [] as string[][],
    customCalls: 0,
    customRenders: [] as string[],
    context: {
      theme,
      async select(_title: string, options: string[]) {
        const choice = uiHarness.selectChoices.shift();
        return choice && options.includes(choice) ? choice : undefined;
      },
      async custom<T>(
        factory: (
          tui: {
            terminal?: { columns: number };
            requestRender(): void;
          },
          innerTheme: Theme,
          _kb: unknown,
          done: (result: T) => void,
        ) =>
          | {
              render?(width: number): string[];
              handleInput?(data: string): void;
              dispose?(): void;
            }
          | Promise<{
              render?(width: number): string[];
              handleInput?(data: string): void;
              dispose?(): void;
            }>,
      ) {
        uiHarness.customCalls += 1;
        return await new Promise<T | undefined>((resolve) => {
          void Promise.resolve(
            factory(
              {
                terminal: { columns: 120 },
                requestRender() {},
              },
              theme,
              {},
              resolve,
            ),
          ).then((component) => {
            if (component.render) {
              uiHarness.customRenders.push(component.render(120).join("\n"));
            }
            const inputs = uiHarness.customInputs.shift() ?? [];
            for (const input of inputs) {
              component.handleInput?.(input);
            }
            component.dispose?.();
          });
        });
      },
      notify() {},
      onTerminalInput() {
        return () => {};
      },
      setStatus() {},
      setWorkingMessage() {},
      setWidget() {},
      setFooter() {},
      setHeader() {},
      setTitle() {},
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() {
        return "";
      },
      async editor() {
        return undefined;
      },
      setEditorComponent() {},
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: true };
      },
      getToolsExpanded() {
        return false;
      },
      setToolsExpanded() {},
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
    } as unknown as ExtensionContext["ui"],
  };

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
    on(name, handler) {
      events.set(
        name,
        handler as (
          event: unknown,
          ctx: ExtensionContext,
        ) => Promise<void> | void,
      );
    },
    appendEntry(customType, data) {
      appendEntries.push({ customType, data });
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

  const flowsCommand = commands.get("flows");
  if (!flowsCommand) throw new Error("/flows command was not registered");

  const flowCommand = commands.get("flow");
  if (!flowCommand) throw new Error("/flow command was not registered");

  if (!agentTool) throw new Error("agent tool was not registered");
  if (!workflowTool) throw new Error("workflow tool was not registered");
  return {
    flowsCommand,
    flowCommand,
    agentTool,
    workflowTool,
    messages,
    appendEntries,
    ui: uiHarness,
    events,
  };
}

function createSessionContext(
  ui: ExtensionContext["ui"],
  options?: {
    sessionFile?: string;
    idle?: () => boolean;
    branch?: unknown[];
    hasUI?: boolean;
  },
): ExtensionContext {
  return {
    cwd: workspaceDir,
    hasUI: options?.hasUI ?? false,
    ui,
    isIdle: options?.idle ?? (() => true),
    sessionManager: {
      getLeafId() {
        return "leaf-1";
      },
      getSessionFile() {
        return options?.sessionFile;
      },
      getBranch() {
        return options?.branch ?? [];
      },
    },
  } as unknown as ExtensionContext;
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

describe("/flows command", () => {
  it("reports an empty flow list before any flows exist", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { flowsCommand, messages, ui } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );
    await flowsCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain(
      "No flows recorded in this session.",
    );
  });

  it("rebuilds flows when switching sessions or tree branches", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { agentTool, flowsCommand, messages, appendEntries, events, ui } =
      setupExtension(createSpawnProcess(() => "ok", inputs));

    await agentTool.execute(
      "call-agent-branch",
      { name: "explorer", task: "inspect" },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    messages.length = 0;
    await flowsCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);
    expect(messages[0]?.content).toContain("explorer");

    const sessionStart = events.get("session_start");
    const sessionTree = events.get("session_tree");
    if (!sessionStart || !sessionTree) {
      throw new Error("expected session lifecycle handlers to be registered");
    }

    await sessionStart({ reason: "resume" }, {
      cwd: workspaceDir,
      hasUI: false,
      sessionManager: {
        getBranch() {
          return [];
        },
      },
    } as unknown as ExtensionContext);

    messages.length = 0;
    await flowsCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);
    expect(messages[0]?.content).toContain(
      "No flows recorded in this session.",
    );

    await sessionTree({}, {
      cwd: workspaceDir,
      hasUI: false,
      sessionManager: {
        getBranch() {
          return appendEntries.map((entry) => ({
            type: "custom",
            customType: entry.customType,
            data: entry.data,
          }));
        },
      },
    } as unknown as ExtensionContext);

    messages.length = 0;
    await flowsCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);
    expect(messages[0]?.content).toContain("explorer");
  });
});

describe("/flow command", () => {
  it("resolves unique flow ID prefixes shown in the overview", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
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
    await flowCommand.handler(prefix, {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain(`ID: ${runId}`);
    expect(messages[0]?.content).not.toContain("Unknown flow");
    expect(messages[0]?.content).toContain("Structure:");
  });

  it("lists direct agent tool executions as flows", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { agentTool, flowsCommand, messages, ui } = setupExtension(
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
    await flowsCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("explorer");
    expect(messages[0]?.content).toContain("completed");
  });

  it("stops an active background flow explicitly", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createLongRunningSpawnProcess(inputs),
    );
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-stop-run",
      {
        flow: {
          kind: "spawn",
          id: "first",
          agent: "explorer",
          task: "inspect",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const runId = result.details.run.id as string;
    messages.length = 0;
    await flowCommand.handler(`stop ${runId}`, {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages[0]?.content).toContain(`Stopping flow ${runId}`);

    await waitFor(() => inputs.length === 1);

    const deadline = Date.now() + 250;
    while (true) {
      messages.length = 0;
      await flowCommand.handler(runId, {
        cwd: workspaceDir,
        hasUI: false,
        ui: ui.context,
      } as unknown as ExtensionContext);
      if (messages[0]?.content.includes("Status: stopped")) break;
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for /flow details to report stopped.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(messages[0]?.content).toContain("Status: stopped");
  });

  it("shows the combined inspect view for a completed flow", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createSpawnProcess((input) => {
        if (input.includes("branch A")) return "result-a";
        if (input.includes("branch B")) return "result-b";
        return "ok";
      }, inputs),
    );

    const result = await workflowTool.execute(
      "call-flow-1",
      {
        label: "Test Pipeline",
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "fork",
              id: "fanout",
              branches: {
                a: {
                  kind: "spawn",
                  id: "a",
                  agent: "worker",
                  task: "branch A",
                },
                b: {
                  kind: "spawn",
                  id: "b",
                  agent: "worker",
                  task: "branch B",
                },
              },
            },
            {
              kind: "join",
              id: "collect",
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

    const runId = result.details.run.id as string;
    const prefix = runId.slice(0, 8);

    messages.length = 0;
    await flowCommand.handler(prefix, {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    const content = messages[0]?.content ?? "";
    expect(content).toContain("Flow: Test Pipeline");
    expect(content).toContain("completed");
    expect(content).toContain("Structure:");
    expect(content).toContain("Status:");
    expect(content).toContain("●");
    expect(content).toContain("fanout");
    expect(content).toContain("⑂ all");
    expect(content).toContain("Results:");
    expect(content).not.toContain("Node Results:");
    expect(content).not.toContain("\nResult:\n");
    expect(content).toContain("branch=a");
    expect(content).toContain("branch=b");
    expect(content).toContain("result-a");
    expect(content).toContain("result-b");
  });

  it("uses the visible structure label in the status tree", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    const result = await workflowTool.execute(
      "call-flow-latest-label",
      {
        label: "Codebase Explorer",
        flow: {
          kind: "fork",
          id: "explore",
          label: "Codebase Explorer",
          branches: {
            developer: {
              kind: "spawn",
              agent: "worker",
              label: "Developer-Facing Explorer",
              task: "dev",
            },
            user: {
              kind: "spawn",
              agent: "worker",
              label: "User-Facing Explorer",
              task: "user",
            },
          },
        },
      },
      undefined,
      undefined,
      createSessionContext(ui.context),
    );

    messages.length = 0;
    await flowCommand.handler(
      result.details.run.id,
      createSessionContext(ui.context),
    );

    const content = messages[0]?.content ?? "";
    expect(content).toContain("Structure:");
    expect(content).toContain("⑃ Codebase Explorer");
    expect(content).toContain("Status:");
    expect(content).toContain("└─ ● User-Facing Explorer: user");
    expect(content).not.toContain("Latest node:");
  });

  it("outputs a Mermaid code fence with the mermaid subcommand", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    const result = await workflowTool.execute(
      "call-flow-mermaid",
      {
        label: "Mermaid Test",
        flow: {
          kind: "spawn",
          id: "only",
          agent: "worker",
          task: "do work",
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const runId = result.details.run.id as string;
    const prefix = runId.slice(0, 8);

    messages.length = 0;
    await flowCommand.handler(`mermaid ${prefix}`, {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    const content = messages[0]?.content ?? "";
    expect(content).toContain("```mermaid");
    expect(content).toContain("flowchart TD");
    expect(content).toContain('(["worker"])');
    expect(content).toContain("```");
  });

  it("reports usage when no flow ID is given in non-interactive mode", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, messages, ui } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    messages.length = 0;
    await flowCommand.handler("", {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Usage: /flow <id-or-prefix>");
  });

  it("opens the interactive picker for bare /flow and inspects the selected flow", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createSpawnProcess(() => "ok", inputs),
    );

    await workflowTool.execute(
      "call-picker-inspect",
      {
        label: "Pick Me",
        flow: {
          kind: "spawn",
          id: "only",
          agent: "worker",
          task: "do work",
        },
      },
      undefined,
      undefined,
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    ui.customInputs.push(["\r"]);
    messages.length = 0;
    await flowCommand.handler("", {
      cwd: workspaceDir,
      hasUI: true,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(ui.customCalls).toBe(1);
    expect(messages[0]?.content).toContain("Flow: Pick Me");
  });

  it("opens watch mode from the picker when no ID is provided", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createLongRunningSpawnProcess(inputs),
    );
    const controller = new AbortController();

    await workflowTool.execute(
      "call-picker-watch",
      {
        flow: {
          kind: "spawn",
          id: "only",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    ui.customInputs.push(["\r"], ["\u001b"]);
    messages.length = 0;
    await flowCommand.handler("watch", {
      cwd: workspaceDir,
      hasUI: true,
      ui: ui.context,
    } as unknown as ExtensionContext);

    expect(ui.customCalls).toBe(2);
    expect(messages).toHaveLength(0);
  });

  it("shows existing running output when attaching to watch mode", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const progress = "partial result before watch";
    const inputs: string[] = [];
    const { flowCommand, workflowTool, messages, ui } = setupExtension(
      createProgressingSpawnProcess(inputs, progress),
    );
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-watch-progress",
      {
        label: "Zoom Flow",
        flow: {
          kind: "spawn",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        const hasProgress = details.nodes.some((node) =>
          node.progress?.text?.includes(progress),
        );
        if (hasProgress) {
          controller.abort();
        }
      },
      { cwd: workspaceDir, hasUI: false } as unknown as ExtensionContext,
    );

    const runId = result.details.run.id as string;
    ui.customInputs.push(["\u001b"]);
    messages.length = 0;
    await flowCommand.handler(`watch ${runId}`, {
      cwd: workspaceDir,
      hasUI: true,
      ui: ui.context,
    } as unknown as ExtensionContext);

    const watchRender = ui.customRenders.at(-1) ?? "";
    expect(watchRender).toContain("Watching Zoom Flow");
    expect(watchRender).toContain("Live tail:");
    expect(watchRender).toContain(progress);
    expect(watchRender).toContain("worker");

    await flowCommand.handler(`stop ${runId}`, {
      cwd: workspaceDir,
      hasUI: false,
      ui: ui.context,
    } as unknown as ExtensionContext);
  });
});

describe("background workflow notifications", () => {
  it("posts spawn and final notifications after a background workflow completes", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { workflowTool, messages, ui } = setupExtension(
      createSpawnProcess(() => "done", inputs),
    );
    const sessionFile = path.join(workspaceDir, "origin-session.jsonl");
    const idle = true;
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-background-notify",
      {
        label: "backgrounded Notify",
        flow: {
          kind: "spawn",
          id: "only",
          label: "Only Step",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      createSessionContext(ui.context, {
        sessionFile,
        idle: () => idle,
      }),
    );

    expect(result.details.run.status).toBe("running");
    await waitFor(
      () =>
        messages.filter(
          (message) => message.customType === "pi-agents:notification",
        ).length === 1,
    );

    const notifications = messages.filter(
      (message) => message.customType === "pi-agents:notification",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("backgrounded Notify");
    expect(notifications[0]?.content).toContain("Use /flow");
    expect(notifications[0]?.content).not.toContain("Only Step");
  });

  it("does not repeat the last step output in the final notification for background sequences", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { workflowTool, messages, ui } = setupExtension(
      createSpawnProcess((input) => {
        if (input.includes("first step")) return "alpha";
        return "beta";
      }, inputs),
    );
    const sessionFile = path.join(workspaceDir, "background-sequence.jsonl");
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-background-sequence-notify",
      {
        label: "backgrounded Sequence",
        flow: {
          kind: "sequence",
          steps: [
            {
              kind: "spawn",
              id: "first",
              label: "First Step",
              agent: "worker",
              task: "first step",
            },
            {
              kind: "spawn",
              id: "second",
              label: "Second Step",
              agent: "worker",
              task: "second step",
            },
          ],
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      createSessionContext(ui.context, {
        sessionFile,
      }),
    );

    expect(result.details.run.status).toBe("running");
    await waitFor(
      () =>
        messages.filter(
          (message) => message.customType === "pi-agents:notification",
        ).length === 3,
    );

    const notifications = messages.filter(
      (message) => message.customType === "pi-agents:notification",
    );
    expect(notifications).toHaveLength(3);
    expect(notifications[0]?.content).toContain("First Step");
    expect(notifications[0]?.content).toContain("alpha");
    expect(notifications[1]?.content).toContain("Second Step");
    expect(notifications[1]?.content).toContain("beta");
    expect(notifications[2]?.content).toContain("backgrounded Sequence");
    expect(notifications[2]?.content).toContain("Use /flow");
    expect(notifications[2]?.content).not.toContain("beta");
    expect(notifications[2]?.content).not.toContain("Second Step");
  });

  it("buffers notifications until the origin session becomes idle", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const { workflowTool, messages, ui, events } = setupExtension(
      createSpawnProcess(() => "done", inputs),
    );
    const sessionFile = path.join(workspaceDir, "busy-session.jsonl");
    let idle = false;
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-background-busy",
      {
        label: "Buffered Notify",
        flow: {
          kind: "spawn",
          id: "only",
          label: "Buffered Step",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      createSessionContext(ui.context, {
        sessionFile,
        idle: () => idle,
      }),
    );

    expect(result.details.run.status).toBe("running");
    await waitFor(() => inputs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      messages.filter(
        (message) => message.customType === "pi-agents:notification",
      ),
    ).toHaveLength(0);

    const agentEnd = events.get("agent_end");
    if (!agentEnd) throw new Error("expected agent_end handler");

    idle = true;
    await agentEnd(
      {},
      createSessionContext(ui.context, {
        sessionFile,
        idle: () => idle,
      }),
    );

    const notifications = messages.filter(
      (message) => message.customType === "pi-agents:notification",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("Buffered Notify");
    expect(notifications[0]?.content).not.toContain("Buffered Step");
  });

  it("keeps only the final notification when the user switches away", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");

    const inputs: string[] = [];
    const deferred = createDeferredSpawnProcess(inputs);
    const { workflowTool, messages, ui, events } = setupExtension(
      deferred.spawnProcess,
    );
    const originSessionFile = path.join(workspaceDir, "origin.jsonl");
    const otherSessionFile = path.join(workspaceDir, "other.jsonl");
    const idle = true;
    const controller = new AbortController();

    const result = await workflowTool.execute(
      "call-background-switch",
      {
        label: "Switch Away",
        flow: {
          kind: "spawn",
          id: "only",
          label: "Switch Step",
          agent: "worker",
          task: "do work",
        },
      },
      controller.signal,
      (update) => {
        const details = update.details as RunResultDetails;
        if (details.run.status === "running") {
          controller.abort();
        }
      },
      createSessionContext(ui.context, {
        sessionFile: originSessionFile,
        idle: () => idle,
      }),
    );

    expect(result.details.run.status).toBe("running");
    await waitFor(() => inputs.length === 1);

    const sessionStart = events.get("session_start");
    if (!sessionStart) throw new Error("expected session_start handler");

    await sessionStart(
      { reason: "resume" },
      createSessionContext(ui.context, {
        sessionFile: otherSessionFile,
        idle: () => idle,
      }),
    );

    deferred.finish("done");
    await waitFor(
      () =>
        readFileSync(originSessionFile, "utf-8").includes(
          '"type":"run_completed"',
        ),
      1000,
    );
    expect(
      messages.filter(
        (message) => message.customType === "pi-agents:notification",
      ),
    ).toHaveLength(0);

    await sessionStart(
      { reason: "resume" },
      createSessionContext(ui.context, {
        sessionFile: originSessionFile,
        idle: () => idle,
      }),
    );

    await waitFor(
      () =>
        messages.filter(
          (message) => message.customType === "pi-agents:notification",
        ).length === 1,
      1000,
    );
    const notifications = messages.filter(
      (message) => message.customType === "pi-agents:notification",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("Switch Away");
    expect(notifications[0]?.content).not.toContain("Switch Step");
  });
});
