/**
 * Subprocess spawn engine: each spawn runs a fresh `pi` process in JSON
 * print mode and parses `message_end` events off stdout.
 *
 *   pi --mode json -p --no-session [--model M] [--thinking T] [--tools a,b]
 *      [--append-system-prompt <tmpfile>]        # task arrives on stdin
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emptyUsage,
  SpawnAborted,
  type SpawnEngine,
  SpawnFailure,
  type SpawnHandle,
  type SpawnOutcome,
  type SpawnProgress,
  type SpawnSpec,
  type SpawnUsage,
} from "./types.js";

export type SpawnProcess = typeof spawn;

/** Environment variable carrying delegation depth across process boundaries. */
export const DEPTH_ENV_VAR = "PI_AGENTS_DEPTH";

/** Environment variable carrying inherited budget limits (JSON) to children. */
export const BUDGETS_ENV_VAR = "PI_AGENTS_BUDGETS";

const FORCE_KILL_AFTER_MS = 5000;

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

interface AssistantMessage {
  role: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

function parseMessageEndEvent(line: string): AssistantMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const event = parsed as { type?: unknown; message?: unknown };
    if (event.type !== "message_end") return undefined;
    if (typeof event.message !== "object" || event.message === null)
      return undefined;
    return event.message as AssistantMessage;
  } catch {
    return undefined;
  }
}

function messageText(message: AssistantMessage): string {
  const chunks: string[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string")
      chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
  const filePath = path.join(dir, `append-system-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
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
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== "")
        cleaned.push("");
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
    spawn(spec: SpawnSpec): SpawnHandle {
      const updates = new AsyncQueue<SpawnProgress>();
      let status: SpawnHandle["status"] = "running";
      let proc: ChildProcessWithoutNullStreams | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let tempDir: string | undefined;
      let settled = false;
      let wasAborted = false;

      const usage: SpawnUsage = emptyUsage();
      let latestText = "";
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let resolvedModel = spec.model;
      let stderr = "";
      let buffered = "";

      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (spec.model) args.push("--model", spec.model);
      if (spec.thinking) args.push("--thinking", spec.thinking);
      // An explicit empty allowlist means "no tools", not "all tools".
      if (spec.tools) {
        if (spec.tools.length === 0) args.push("--no-tools");
        else args.push("--tools", spec.tools.join(","));
      }
      if (spec.systemPrompt?.trim()) {
        const tmp = writePromptToTempFile(spec.agent, spec.systemPrompt.trim());
        tempDir = tmp.dir;
        args.push("--append-system-prompt", tmp.filePath);
      }

      const cleanup = () => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
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
        const message = parseMessageEndEvent(line);
        if (!message) return;
        if (message.role === "assistant") {
          usage.turns += 1;
          if (message.usage) {
            usage.input += message.usage.input || 0;
            usage.output += message.usage.output || 0;
            usage.cacheRead += message.usage.cacheRead || 0;
            usage.cacheWrite += message.usage.cacheWrite || 0;
            usage.cost += message.usage.cost?.total || 0;
            usage.contextTokens =
              message.usage.totalTokens || usage.contextTokens;
          }
          if (message.model) resolvedModel = message.model;
          if (message.stopReason) stopReason = message.stopReason;
          if (message.errorMessage) errorMessage = message.errorMessage;
          const text = messageText(message);
          if (text) latestText = text;
        }
        updates.push({ text: latestText, usage: { ...usage } });
      };

      const waitPromise = new Promise<SpawnOutcome>((resolve, reject) => {
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
          status = "failed";
          cleanup();
          reject(
            new SpawnFailure(
              `Failed to spawn "pi": ${errorText}`,
              spec.agent,
              1,
            ),
          );
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

          if (wasAborted) {
            status = "aborted";
            cleanup();
            reject(new SpawnAborted(spec.agent));
            return;
          }

          const exitCode = signalCode ? 1 : (code ?? 0);
          const isError =
            exitCode !== 0 ||
            stopReason === "error" ||
            stopReason === "aborted" ||
            Boolean(signalCode);
          if (isError) {
            status = "failed";
            const signalNote = signalCode
              ? `Delegated "pi" process terminated by signal ${signalCode}.`
              : "";
            const rawReason =
              errorMessage ||
              stderr ||
              signalNote ||
              latestText ||
              "(no output)";
            const reason = formatFailureReason(rawReason, resolvedModel);
            cleanup();
            reject(
              new SpawnFailure(
                `Agent ${spec.agent} failed: ${reason}`,
                spec.agent,
                exitCode,
                stderr,
              ),
            );
            return;
          }

          status = "completed";
          cleanup();
          resolve({
            text: latestText || "(no output)",
            exitCode,
            usage: { ...usage },
            model: resolvedModel,
          });
        });

        proc.on("error", (error) => {
          if (settled) return;
          settled = true;
          const errorText =
            error instanceof Error ? error.message : String(error);
          status = "failed";
          cleanup();
          reject(
            new SpawnFailure(
              `Failed to spawn "pi": ${errorText}`,
              spec.agent,
              1,
              stderr,
            ),
          );
        });

        proc.stdin.end(spec.task);
      });
      // Prevent unhandled-rejection noise when abort() races wait().
      waitPromise.catch(() => {});

      return {
        get status() {
          return status;
        },
        updates,
        wait: () => waitPromise,
        abort: () => {
          if (wasAborted) return;
          wasAborted = true;
          if (!proc) return;
          proc.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (proc && isChildProcessRunning(proc)) proc.kill("SIGKILL");
          }, FORCE_KILL_AFTER_MS);
        },
      };
    },
  };
}
