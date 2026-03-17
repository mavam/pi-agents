import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentExtension,
  type SpawnProcess,
} from "../extensions/agent/index.ts";

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
      "---",
      "",
      "Run delegated work.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function createSpawnProcess(): SpawnProcess {
  return () => {
    throw new Error("spawn should not be called in prompt injection tests");
  };
}

function setupExtension() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  createAgentExtension({ spawnProcess: createSpawnProcess() })({
    registerCommand() {
      // not needed
    },
    registerTool() {
      // not needed
    },
    sendMessage() {
      // not needed
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    appendEntry() {
      // not needed
    },
    getThinkingLevel() {
      return "off";
    },
    events: {
      emit() {
        // not needed
      },
    },
  } as unknown as ExtensionAPI);

  const run = async (eventName: string, event: unknown) => {
    const matching = handlers.get(eventName) ?? [];
    const results = await Promise.all(
      matching.map((handler) =>
        handler(event, { cwd: workspaceDir, hasUI: false } as ExtensionContext),
      ),
    );
    return results;
  };

  return { handlers, run };
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-workflow-prompt-test-"));
  workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "pi-workflow-prompt-workspace-"),
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

describe("workflow agent prompt injection", () => {
  it("injects the workflow catalog when orchestration is requested", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const { run } = setupExtension();

    const [result] = (await run("before_agent_start", {
      prompt: "Build a workflow with two parallel branches.",
      systemPrompt: "base prompt",
    })) as Array<{ systemPrompt?: string } | undefined>;

    expect(result?.systemPrompt).toContain("## Workflow agent catalog");
    expect(result?.systemPrompt).toContain('<agent name="worker"');
  });

  it("does not inject the workflow catalog for unrelated prompts", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const { run } = setupExtension();

    const [result] = (await run("before_agent_start", {
      prompt: "Fix the failing test in this file.",
      systemPrompt: "base prompt",
    })) as Array<{ systemPrompt?: string } | undefined>;

    expect(result).toBeUndefined();
  });

  it("keeps the workflow catalog available right after workflow execution", async () => {
    writeAgent(path.join(projectAgentsDir(), "worker.md"), "worker", "Worker");
    const { run } = setupExtension();

    await run("agent_start", { type: "agent_start" });
    await run("tool_execution_end", {
      toolName: "workflow",
      isError: false,
      result: {},
    });
    await run("agent_end", { type: "agent_end", messages: [] });

    const [result] = (await run("before_agent_start", {
      prompt: "continue",
      systemPrompt: "base prompt",
    })) as Array<{ systemPrompt?: string } | undefined>;

    expect(result?.systemPrompt).toContain("## Workflow agent catalog");
    expect(result?.systemPrompt).toContain('<agent name="worker"');
  });
});
