/**
 * Subprocess spawn engine: each spawn runs a fresh `pi` process in RPC mode,
 * sends one initial prompt, and keeps stdin open for steering and aborts.
 *
 *   pi --mode rpc --no-session [--model M] [--thinking T] [--tools a,b]
 *      [--append-system-prompt <tmpfile>]
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
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

const CONTROL_RESPONSE_TIMEOUT_MS = 30_000;
const TERMINATE_AFTER_MS = 1_000;
const FORCE_KILL_AFTER_MS = 5_000;

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

interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface PendingCommand {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantMessage(value: unknown): AssistantMessage | undefined {
  if (!isRecord(value) || value.type !== "message_end") return undefined;
  if (!isRecord(value.message)) return undefined;
  if (value.message.role !== "assistant") return undefined;
  if (
    value.message.content !== undefined &&
    !Array.isArray(value.message.content)
  ) {
    throw new Error("Invalid assistant message content from delegated pi");
  }
  for (const part of value.message.content ?? []) {
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new Error("Invalid assistant message content from delegated pi");
    }
    if (part.text !== undefined && typeof part.text !== "string") {
      throw new Error("Invalid assistant message text from delegated pi");
    }
  }
  const usage = value.message.usage;
  if (usage !== undefined) {
    if (!isRecord(usage)) {
      throw new Error("Invalid assistant message usage from delegated pi");
    }
    for (const field of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ]) {
      const amount = usage[field];
      if (
        amount !== undefined &&
        (typeof amount !== "number" || !Number.isFinite(amount))
      ) {
        throw new Error("Invalid assistant message usage from delegated pi");
      }
    }
    if (usage.cost !== undefined) {
      if (!isRecord(usage.cost)) {
        throw new Error("Invalid assistant message cost from delegated pi");
      }
      const total = usage.cost.total;
      if (
        total !== undefined &&
        (typeof total !== "number" || !Number.isFinite(total))
      ) {
        throw new Error("Invalid assistant message cost from delegated pi");
      }
    }
  }
  for (const field of ["model", "stopReason", "errorMessage"]) {
    const text = value.message[field];
    if (text !== undefined && typeof text !== "string") {
      throw new Error(`Invalid assistant message ${field} from delegated pi`);
    }
  }
  return value.message as unknown as AssistantMessage;
}

function idleRpcState(value: unknown): boolean {
  if (!isRecord(value)) {
    throw new Error("Invalid get_state response from delegated pi");
  }
  if (
    typeof value.isStreaming !== "boolean" ||
    typeof value.pendingMessageCount !== "number"
  ) {
    throw new Error("Invalid get_state response from delegated pi");
  }
  return !value.isStreaming && value.pendingMessageCount === 0;
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
  /** Test hooks; production uses the conservative defaults above. */
  terminateAfterMs?: number;
  forceKillAfterMs?: number;
}): SpawnEngine {
  const spawnProcess = options?.spawnProcess ?? spawn;
  const terminateAfterMs = options?.terminateAfterMs ?? TERMINATE_AFTER_MS;
  const forceKillAfterMs = options?.forceKillAfterMs ?? FORCE_KILL_AFTER_MS;

  return {
    spawn(spec: SpawnSpec): SpawnHandle {
      const updates = new AsyncQueue<SpawnProgress>();
      let status: SpawnHandle["status"] = "running";
      let proc: ChildProcessWithoutNullStreams | undefined;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let tempDir: string | undefined;
      let settled = false;
      let agentStarted = false;
      let agentSettled = false;
      let promptAccepted = false;
      let stdinEnded = false;
      let sentTerminationSignal = false;
      let wasAborted = false;
      let terminalFailure: Error | undefined;

      const usage: SpawnUsage = emptyUsage();
      let latestText = "";
      let currentTool: string | undefined;
      let turnsStarted = 0;
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let resolvedModel = spec.model;
      let stderr = "";
      let buffered = "";
      const decoder = new StringDecoder("utf8");
      const pendingCommands = new Map<string, PendingCommand>();
      let requestId = 0;

      const args: string[] = ["--mode", "rpc", "--no-session"];
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

      let resolveWait!: (outcome: SpawnOutcome) => void;
      let rejectWait!: (error: Error) => void;
      const waitPromise = new Promise<SpawnOutcome>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      });
      // Prevent unhandled-rejection noise when abort() races wait().
      waitPromise.catch(() => {});

      const cleanup = () => {
        if (terminateTimer) clearTimeout(terminateTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        terminateTimer = undefined;
        forceKillTimer = undefined;
        for (const pending of pendingCommands.values()) {
          clearTimeout(pending.timer);
        }
        pendingCommands.clear();
        if (tempDir) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors.
          }
          tempDir = undefined;
        }
        updates.finish();
      };

      const rejectPending = (error: Error) => {
        for (const pending of pendingCommands.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        pendingCommands.clear();
      };

      const scheduleTermination = () => {
        if (!proc || terminateTimer || forceKillTimer) return;
        terminateTimer = setTimeout(() => {
          terminateTimer = undefined;
          if (!proc || !isChildProcessRunning(proc)) return;
          sentTerminationSignal = true;
          proc.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            forceKillTimer = undefined;
            if (proc && isChildProcessRunning(proc)) proc.kill("SIGKILL");
          }, forceKillAfterMs);
          forceKillTimer.unref?.();
        }, terminateAfterMs);
        terminateTimer.unref?.();
      };

      const endStdin = () => {
        if (!proc || stdinEnded) return;
        stdinEnded = true;
        proc.stdin.end();
        scheduleTermination();
      };

      const failProtocol = (message: string) => {
        if (settled || terminalFailure || wasAborted) return;
        terminalFailure = new Error(message);
        rejectPending(terminalFailure);
        endStdin();
      };

      const writeRecord = (record: Record<string, unknown>): void => {
        if (!proc || stdinEnded || !isChildProcessRunning(proc)) {
          throw new Error("Delegated pi RPC process is not writable");
        }
        proc.stdin.write(`${JSON.stringify(record)}\n`);
      };

      const sendCommand = (
        command: Record<string, unknown> & { type: string },
      ): Promise<RpcResponse> => {
        const id = `pi-agents-${++requestId}`;
        return new Promise<RpcResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingCommands.delete(id);
            reject(
              new Error(
                `Timed out waiting for pi RPC '${command.type}' response`,
              ),
            );
          }, CONTROL_RESPONSE_TIMEOUT_MS);
          timer.unref?.();
          pendingCommands.set(id, {
            command: command.type,
            resolve: (response) => {
              clearTimeout(timer);
              resolve(response);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
            timer,
          });
          try {
            writeRecord({ ...command, id });
          } catch (error) {
            pendingCommands.delete(id);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };

      const pushUpdate = () => {
        updates.push({
          text: latestText,
          usage: { ...usage },
          currentTool,
          turnsStarted,
        });
      };

      const recordAssistantMessage = (message: AssistantMessage) => {
        if (message.role === "assistant") {
          usage.turns += 1;
          // Engines older than turn_start reporting still get a sane count.
          turnsStarted = Math.max(turnsStarted, usage.turns);
          if (message.usage) {
            usage.input += message.usage.input || 0;
            usage.output += message.usage.output || 0;
            usage.cacheRead += message.usage.cacheRead || 0;
            usage.cacheWrite += message.usage.cacheWrite || 0;
            usage.cost += message.usage.cost?.total || 0;
            usage.contextTokens = Math.max(
              usage.contextTokens,
              message.usage.totalTokens || 0,
            );
          }
          if (message.model) resolvedModel = message.model;
          if (message.stopReason) stopReason = message.stopReason;
          if (message.errorMessage) errorMessage = message.errorMessage;
          const text = messageText(message);
          if (text) latestText = text;
        }
        pushUpdate();
      };

      const handleResponse = (response: RpcResponse) => {
        if (!response.id) return;
        const pending = pendingCommands.get(response.id);
        if (!pending) return;
        pendingCommands.delete(response.id);
        if (response.success) {
          pending.resolve(response);
          return;
        }
        pending.reject(
          new Error(
            response.error || `pi RPC '${pending.command}' command failed`,
          ),
        );
      };

      const handleExtensionUiRequest = (record: Record<string, unknown>) => {
        if (typeof record.id !== "string" || typeof record.method !== "string")
          return;
        if (["select", "confirm", "input", "editor"].includes(record.method)) {
          try {
            writeRecord({
              type: "extension_ui_response",
              id: record.id,
              cancelled: true,
            });
          } catch (error) {
            failProtocol(
              `Failed to cancel delegated extension UI request: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };

      const parseLine = (rawLine: string) => {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line) return;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          failProtocol(
            `Invalid JSON from delegated pi RPC process: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (!isRecord(record) || typeof record.type !== "string") {
          failProtocol("Invalid record from delegated pi RPC process");
          return;
        }
        try {
          if (record.type === "response") {
            if (typeof record.success !== "boolean") {
              throw new Error("Invalid response from delegated pi RPC process");
            }
            handleResponse(record as unknown as RpcResponse);
            return;
          }
          if (record.type === "extension_ui_request") {
            handleExtensionUiRequest(record);
            return;
          }
          const message = assistantMessage(record);
          if (message) recordAssistantMessage(message);
          // Turn and tool activity keep the caller's liveness view fresh
          // between assistant messages (a thinking turn can run minutes).
          if (record.type === "turn_start") {
            turnsStarted += 1;
            pushUpdate();
          }
          if (
            record.type === "tool_execution_start" &&
            typeof record.toolName === "string"
          ) {
            currentTool = record.toolName;
            pushUpdate();
          }
          if (record.type === "tool_execution_end" && currentTool) {
            currentTool = undefined;
            pushUpdate();
          }
          if (record.type === "agent_start") agentStarted = true;
          if (record.type === "agent_settled" && !agentSettled) {
            agentSettled = true;
            endStdin();
          }
        } catch (error) {
          failProtocol(
            error instanceof Error
              ? error.message
              : "Invalid record from delegated pi RPC process",
          );
        }
      };

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
        rejectWait(
          new SpawnFailure(`Failed to spawn "pi": ${errorText}`, spec.agent, 1),
        );
      }

      if (proc) {
        proc.stdout.on("data", (chunk) => {
          buffered +=
            typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
          while (true) {
            const newlineIndex = buffered.indexOf("\n");
            if (newlineIndex === -1) break;
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);
            parseLine(line);
          }
        });

        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.stdin.on("error", (error) => {
          // EOF is the normal post-settlement shutdown path. Any earlier
          // broken pipe means a control command could not be delivered.
          if (agentSettled && stdinEnded) return;
          failProtocol(
            `Failed to write to delegated pi RPC process: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

        proc.on("close", (code, signalCode) => {
          if (settled) return;
          buffered += decoder.end();
          if (buffered) {
            const finalLine = buffered;
            buffered = "";
            parseLine(finalLine);
          }
          settled = true;
          const closedError = new Error(
            `Delegated pi RPC process exited before responding (code=${String(code)}, signal=${String(signalCode)})`,
          );
          rejectPending(closedError);

          if (wasAborted) {
            status = "aborted";
            cleanup();
            rejectWait(new SpawnAborted(spec.agent));
            return;
          }

          const exitCode = signalCode ? 1 : (code ?? 0);
          const processFailed =
            terminalFailure !== undefined ||
            !agentSettled ||
            stopReason === "error" ||
            stopReason === "aborted" ||
            (exitCode !== 0 && !sentTerminationSignal);
          if (processFailed) {
            status = "failed";
            const signalNote = signalCode
              ? `Delegated "pi" process terminated by signal ${signalCode}.`
              : "";
            const rawReason =
              terminalFailure?.message ||
              errorMessage ||
              stderr ||
              signalNote ||
              (!agentSettled
                ? "Delegated pi RPC process exited before agent_settled."
                : latestText || "(no output)");
            const reason = formatFailureReason(rawReason, resolvedModel);
            cleanup();
            rejectWait(
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
          resolveWait({
            text: latestText || "(no output)",
            exitCode,
            usage: { ...usage },
            model: resolvedModel,
          });
        });

        proc.on("error", (error) => {
          if (settled) return;
          failProtocol(
            `Failed to run delegated "pi": ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }

      const startupPromise = proc
        ? (async () => {
            try {
              await sendCommand({
                type: "set_steering_mode",
                mode: "one-at-a-time",
              });
            } catch (error) {
              const cause =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `Pi RPC initialization failed while configuring steering mode. pi-agents requires the latest Pi release; run "pi update pi" and retry. Cause: ${cause}`,
              );
            }
            if (wasAborted) throw new SpawnAborted(spec.agent);
            await sendCommand({ type: "prompt", message: spec.task });
            promptAccepted = true;
            if (agentStarted || agentSettled) return;
            const state = await sendCommand({ type: "get_state" });
            if (!agentStarted && !agentSettled && idleRpcState(state.data)) {
              throw new Error(
                "Delegated pi accepted the prompt without starting an agent run",
              );
            }
          })()
        : Promise.reject(new Error("Delegated pi RPC process did not start"));

      startupPromise.catch((error) => {
        if (wasAborted || settled) return;
        failProtocol(
          `Failed to initialize delegated pi RPC process: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      return {
        get status() {
          return status;
        },
        updates,
        wait: () => waitPromise,
        steer: async (message: string) => {
          await startupPromise;
          if (wasAborted || agentSettled || settled || status !== "running") {
            throw new Error(`Agent ${spec.agent} is no longer running`);
          }
          await Promise.race([
            sendCommand({ type: "steer", message }),
            waitPromise.then(
              () => Promise.reject(new Error(`Agent ${spec.agent} settled`)),
              () => Promise.reject(new Error(`Agent ${spec.agent} settled`)),
            ),
          ]);
        },
        abort: () => {
          if (wasAborted || settled) return;
          wasAborted = true;
          if (!proc) return;
          if (!promptAccepted) {
            endStdin();
            return;
          }
          void sendCommand({ type: "abort" }).catch(() => {});
          scheduleTermination();
        },
      };
    },
  };
}
