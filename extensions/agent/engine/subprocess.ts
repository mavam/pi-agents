import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { buildSkillsPrompt } from "../agents.js";
import type { AgentRunDetails, UsageStats } from "../types.js";
import type {
  SpawnEngine,
  SpawnHandle,
  SpawnRequest,
  SpawnResult,
  SpawnUpdate,
} from "./interface.js";

export type SpawnProcess = typeof spawn;

export class DelegatedAgentRunError extends Error {
  readonly details: AgentRunDetails;

  constructor(message: string, details: AgentRunDetails) {
    super(message);
    this.name = "DelegatedAgentRunError";
    this.details = details;
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly pending: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.pending.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.pending.length > 0) {
      this.pending.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { value: this.values.shift() as T, done: false };
        }
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.pending.push(resolve);
        });
      },
    };
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const chunks: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text") chunks.push(part.text);
    }
    if (chunks.length > 0) return chunks.join("\n").trim();
  }
  return "";
}

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-run-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
  const filePath = path.join(dir, `append-system-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

function initialUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function parseMessageEndEvent(line: string): Message | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const event = parsed as { type?: unknown; message?: unknown };
    if (event.type !== "message_end") return null;
    if (typeof event.message !== "object" || event.message === null) {
      return null;
    }
    return event.message as Message;
  } catch {
    return null;
  }
}

export function isChildProcessRunning(
  proc: Pick<ChildProcessWithoutNullStreams, "exitCode" | "signalCode">,
): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function stripStackTrace(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== "") {
        cleaned.push("");
      }
      continue;
    }
    if (trimmed.startsWith("at ")) continue;
    if (trimmed.startsWith("file://")) continue;
    if (/^Node\.js v\d+/i.test(trimmed)) continue;
    cleaned.push(trimmed);
  }

  return cleaned.join("\n").trim();
}

export function formatFailureReason(
  rawReason: string,
  modelHint?: string,
): string {
  const compact = stripStackTrace(rawReason);
  const source = compact || rawReason;
  const missingKeyMatch = source.match(/No API key found for ([^.\n]+)/i);
  if (missingKeyMatch) {
    const provider = missingKeyMatch[1]?.trim() || "the selected provider";
    const model = modelHint ? ` Model: ${modelHint}.` : "";
    return `No credentials configured for provider "${provider}".${model} Run /login or configure the provider API key, then retry.`;
  }

  return compact || "(no output)";
}

export function createSubprocessSpawnEngine(options?: {
  spawnProcess?: SpawnProcess;
}): SpawnEngine {
  const spawnProcess = options?.spawnProcess ?? spawn;

  return {
    spawn(spec: SpawnRequest): SpawnHandle {
      const updates = new AsyncQueue<SpawnUpdate>();
      const id = crypto.randomUUID();
      const depth = spec.depth ?? 0;
      let status: SpawnHandle["status"] = "running";
      let proc: ChildProcessWithoutNullStreams | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let tempDir: string | undefined;
      let tempPromptPath: string | undefined;
      let settled = false;
      let wasAborted = false;

      const messages: Message[] = [];
      const usage = initialUsage();
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      const effectiveModel = spec.agent.model ?? spec.defaultModel;
      const effectiveThinking = spec.agent.thinking ?? spec.defaultThinking;
      let resolvedModel = effectiveModel;
      let stderr = "";

      const details = (exitCode: number): AgentRunDetails => ({
        agent: spec.agent.name,
        agentSource: spec.agent.source,
        model: resolvedModel,
        thinking: effectiveThinking,
        skills: [...spec.agent.skills],
        missingSkills,
        exitCode,
        stopReason,
        errorMessage,
        stderr,
        usage: { ...usage },
        discoveryDiagnostics: spec.discoveryDiagnostics,
        scope: spec.scope,
      });

      const { prompt: skillsPrompt, missingSkills } = buildSkillsPrompt(
        spec.agent.skills,
        spec.cwd,
      );
      const appendParts = [
        spec.agent.systemPrompt.trim(),
        skillsPrompt.trim(),
      ].filter(Boolean);

      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (effectiveModel) args.push("--model", effectiveModel);
      if (effectiveThinking) args.push("--thinking", effectiveThinking);
      if (appendParts.length > 0) {
        const tmp = writePromptToTempFile(
          spec.agent.name,
          appendParts.join("\n\n"),
        );
        tempDir = tmp.dir;
        tempPromptPath = tmp.filePath;
        args.push("--append-system-prompt", tempPromptPath);
      }

      let buffered = "";

      const cleanup = () => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        if (tempPromptPath) {
          try {
            fs.unlinkSync(tempPromptPath);
          } catch {
            // ignore cleanup errors
          }
          tempPromptPath = undefined;
        }
        if (tempDir) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
          tempDir = undefined;
        }
        updates.finish();
      };

      const parseLine = (line: string) => {
        if (!line.trim()) return;
        const msg = parseMessageEndEvent(line);
        if (!msg) return;

        messages.push(msg);
        if (msg.role === "assistant") {
          usage.turns += 1;
          if (msg.usage) {
            usage.input += msg.usage.input || 0;
            usage.output += msg.usage.output || 0;
            usage.cacheRead += msg.usage.cacheRead || 0;
            usage.cacheWrite += msg.usage.cacheWrite || 0;
            usage.cost += msg.usage.cost?.total || 0;
            usage.contextTokens = msg.usage.totalTokens || usage.contextTokens;
          }
          if (msg.model) resolvedModel = msg.model;
          if (msg.stopReason) stopReason = msg.stopReason;
          if (msg.errorMessage) errorMessage = msg.errorMessage;
        }
        updates.push({
          text: getFinalOutput(messages) || "(running...)",
          details: details(-1),
        });
      };

      const waitPromise = new Promise<SpawnResult>((resolve, reject) => {
        try {
          proc = spawnProcess("pi", args, {
            cwd: spec.cwd,
            env: { ...process.env, ...(spec.env ?? {}) },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : String(error);
          const spawnFailure = `Failed to spawn "pi": ${errorText}`;
          stderr = spawnFailure;
          errorMessage = spawnFailure;
          status = "stopped";
          cleanup();
          reject(new DelegatedAgentRunError(spawnFailure, details(1)));
          return;
        }

        proc.stdout.on("data", (chunk) => {
          buffered += chunk.toString();
          const lines = buffered.split("\n");
          buffered = lines.pop() || "";
          for (const line of lines) parseLine(line);
        });

        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.on("close", (code, signalCode) => {
          if (settled) return;
          settled = true;
          if (buffered.trim()) parseLine(buffered);

          const exitCode = signalCode ? 1 : (code ?? 0);
          if (signalCode) {
            const signalFailure = `Delegated "pi" process terminated by signal ${signalCode}.`;
            stderr = stderr ? `${stderr}\n${signalFailure}` : signalFailure;
            if (!errorMessage) errorMessage = signalFailure;
          }

          if (wasAborted) {
            status = "stopped";
            cleanup();
            reject(
              new DelegatedAgentRunError(
                `Agent ${spec.agent.name} aborted.`,
                details(exitCode || 1),
              ),
            );
            return;
          }

          const finalText = getFinalOutput(messages);
          const isError =
            exitCode !== 0 ||
            stopReason === "error" ||
            stopReason === "aborted" ||
            Boolean(signalCode);
          if (isError) {
            status = "stopped";
            const rawReason =
              errorMessage || stderr || finalText || "(no output)";
            const reason = formatFailureReason(rawReason, resolvedModel);
            cleanup();
            reject(
              new DelegatedAgentRunError(
                `Agent ${spec.agent.name} failed: ${reason}`,
                details(exitCode),
              ),
            );
            return;
          }

          status = "completed";
          cleanup();
          resolve({
            id,
            runId: spec.runId,
            parentNodeId: spec.parentNodeId,
            depth,
            agent: spec.agent.name,
            text: finalText || "(no output)",
            exitCode,
            usage: { ...usage },
            model: resolvedModel,
            details: details(exitCode),
          });
        });

        proc.on("error", (error) => {
          if (settled) return;
          settled = true;
          const errorText =
            error instanceof Error ? error.message : String(error);
          const spawnFailure = `Failed to spawn "pi": ${errorText}`;
          stderr = stderr ? `${stderr}\n${spawnFailure}` : spawnFailure;
          if (!errorMessage) errorMessage = spawnFailure;
          status = "stopped";
          cleanup();
          reject(new DelegatedAgentRunError(spawnFailure, details(1)));
        });

        proc.stdin.end(spec.task);
      });

      return {
        id,
        runId: spec.runId,
        parentNodeId: spec.parentNodeId,
        depth,
        get status() {
          return status;
        },
        updates,
        wait: () => waitPromise,
        abort: async () => {
          if (wasAborted) return;
          wasAborted = true;
          status = "stopped";
          if (!proc) return;
          proc.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (proc && isChildProcessRunning(proc)) proc.kill("SIGKILL");
          }, 5000);
        },
        capabilities: {
          steer: false,
          resume: false,
          transcript: false,
        },
      };
    },
  };
}
