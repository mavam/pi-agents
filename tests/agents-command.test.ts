import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import agentExtension from "../extensions/agent/index.ts";

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

function userAgentsDir(): string {
  return path.join(sandboxDir, ".pi", "agents");
}

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

function setupExtension(): {
  agentsCommand: RegisteredCommand;
  agentCommand: RegisteredCommand;
  messages: CapturedMessage[];
} {
  const commands = new Map<string, RegisteredCommand>();
  const messages: CapturedMessage[] = [];

  agentExtension({
    registerCommand(name, options) {
      commands.set(name, options as RegisteredCommand);
    },
    registerTool() {
      // not needed for command tests
    },
    sendMessage(message) {
      messages.push(message as CapturedMessage);
    },
    on() {
      // not needed for command tests
    },
  } as unknown as ExtensionAPI);

  const agentsCommand = commands.get("agents");
  if (!agentsCommand) throw new Error("/agents command was not registered");

  const agentCommand = commands.get("agent");
  if (!agentCommand) throw new Error("/agent command was not registered");

  return { agentsCommand, agentCommand, messages };
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-agents-cmd-test-"));
  workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "pi-agents-cmd-workspace-"),
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

describe("/agents command", () => {
  it("lists discovered agents", async () => {
    writeAgent(
      path.join(userAgentsDir(), "explorer.md"),
      "explorer",
      "User explorer",
    );
    writeAgent(
      path.join(projectAgentsDir(), "worker.md"),
      "worker",
      "Project worker",
    );

    const { agentsCommand, messages } = setupExtension();
    await agentsCommand.handler("", { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Available agents");
    expect(messages[0]?.content).toContain("explorer (user)");
    expect(messages[0]?.content).toContain("worker (project)");
    expect(messages[0]?.content).toContain(
      "Use /agent <name> for full details.",
    );
  });
});

describe("/agent command", () => {
  it("shows details for a specific agent", async () => {
    writeAgent(
      path.join(projectAgentsDir(), "explorer.md"),
      "explorer",
      "Project explorer",
    );

    const { agentCommand, messages } = setupExtension();
    await agentCommand.handler("explorer", { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Agent: explorer");
    expect(messages[0]?.content).toContain("Source: project");
    expect(messages[0]?.content).toContain("Description: Project explorer");
    expect(messages[0]?.content).toContain("System prompt:");
  });

  it("reports unknown agent names", async () => {
    writeAgent(
      path.join(userAgentsDir(), "explorer.md"),
      "explorer",
      "User explorer",
    );

    const { agentCommand, messages } = setupExtension();
    await agentCommand.handler("missing", { cwd: workspaceDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('Unknown agent "missing"');
    expect(messages[0]?.content).toContain("explorer (user)");
  });
});
