/**
 * Subprocess spawn engine: each spawn runs a fresh `pi` process in RPC mode,
 * sends one initial prompt, and keeps stdin open for injected prompts and
 * aborts.
 *
 *   pi --mode rpc [--session-dir <dir>] --extension <result-tool>
 *      [--model M] [--thinking T] [--tools a,b]
 *      [--append-system-prompt <tmpfile>]
 *
 * The child writes a real pi session (attachable after the agent settles);
 * its path is discovered via `get_state` and exposed as `nativeSession`.
 * The result payload schema travels through a private per-spawn file named by
 * PI_AGENTS_RESULT_SCHEMA_FILE.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  effectiveResultSchema,
  validateJsonSchema,
} from "../model/json-schema.js";
import {
  RESULT_HOLD_FILE_ENV_VAR,
  RESULT_SCHEMA_FILE_ENV_VAR,
  RESULT_TOOL_NAME,
} from "./result-tool.js";
import {
  AgentErrorResult,
  emptyUsage,
  SpawnAborted,
  type SpawnEngine,
  SpawnFailure,
  type SpawnHandle,
  type SpawnOutcome,
  type SpawnProgress,
  type SpawnSpec,
  type SpawnUsage,
  type TranscriptItem,
  UnsubmittedResult,
} from "./types.js";

export type SpawnProcess = typeof spawn;

/** Environment variable carrying delegation depth across process boundaries. */
export const DEPTH_ENV_VAR = "PI_AGENTS_DEPTH";

const CONTROL_RESPONSE_TIMEOUT_MS = 30_000;
const TERMINATE_AFTER_MS = 1_000;
const FORCE_KILL_AFTER_MS = 5_000;
const SUMMARY_DEBOUNCE_MS = 250;
/** Minimum spacing between updates driven by streaming text deltas. */
export const STREAM_PUSH_INTERVAL_MS = 250;
/** Live transcripts are ephemeral and bounded. Only an accepted agent result
 * submission becomes a durable workflow value; the child's own session file
 * carries the full durable history. */
export const MAX_TRANSCRIPT_CHARS = 512_000;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_TOOL_LABEL_CHARS = 240;
const RESULT_TOOL_EXTENSION_PATH = fileURLToPath(
  new URL("./result-tool.ts", import.meta.url),
);

/** Put the live user's intent next to every injected prompt. The delegated
 * system contract alone is too far from the latest message for some models:
 * they otherwise resume the original task, call tools, or submit a result
 * without producing any assistant text for the attached user to see. */
export function attachedSupervisorPrompt(message: string): string {
  return [
    "A supervising user is attached to this delegated session.",
    "Reply to their message in visible assistant text before using any tool, submitting a result, or resuming the assignment.",
    "A tool call or result submission is not a reply. After replying, follow the message as the latest authoritative instruction.",
    "<supervisor-message>",
    message,
    "</supervisor-message>",
  ].join("\n");
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

interface AssistantMessage {
  role: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: string;
  provider?: string;
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

function jsonChars(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Full retained size of one item, raw payloads included. */
function itemChars(item: TranscriptItem): number {
  switch (item.kind) {
    case "user":
    case "notice":
      return item.text.length;
    case "assistant":
      return (
        item.text.length +
        (item.summary?.length ?? 0) +
        (item.thinking?.length ?? 0) +
        jsonChars(item.message)
      );
    case "tool":
      return (
        item.label.length +
        (item.output?.length ?? 0) +
        jsonChars(item.args) +
        jsonChars(item.result)
      );
  }
}

const CLIP_MARKER = "… earlier output omitted …\n";

/** Clip one pathologically large item in place, dropping its raw payloads. */
function clipItem(item: TranscriptItem): void {
  const keep = Math.max(1_000, MAX_TRANSCRIPT_CHARS - CLIP_MARKER.length);
  if (item.kind === "assistant") {
    item.message = undefined;
    item.thinking = undefined;
    if (item.text.length > keep) {
      item.text = `${CLIP_MARKER}${item.text.slice(-keep)}`;
    }
    return;
  }
  if (item.kind === "tool") {
    item.result = undefined;
    item.args = undefined;
    if (item.output !== undefined && item.output.length > keep) {
      item.output = `${CLIP_MARKER}${item.output.slice(-keep)}`;
    }
    return;
  }
  if (item.text.length > keep) {
    item.text = `${CLIP_MARKER}${item.text.slice(-keep)}`;
  }
}

/** Chronological, bounded live transcript. Mutable entries let streaming
 * assistant messages and tool output update in place while completed entries
 * stay in order. The oldest entries fall off past MAX_TRANSCRIPT_CHARS. */
class TranscriptStore {
  private readonly items: TranscriptItem[] = [];
  private readonly byKey = new Map<string, TranscriptItem>();
  private chars = 0;
  private revision = 0;

  upsert(item: TranscriptItem): void {
    item.rev = ++this.revision;
    const existing = this.byKey.get(item.key);
    if (existing) {
      this.chars -= itemChars(existing);
      Object.assign(existing, item);
      this.chars += itemChars(existing);
    } else {
      this.items.push(item);
      this.byKey.set(item.key, item);
      this.chars += itemChars(item);
    }
    while (this.items.length > 1 && this.chars > MAX_TRANSCRIPT_CHARS) {
      const removed = this.items.shift();
      if (!removed) break;
      this.byKey.delete(removed.key);
      this.chars -= itemChars(removed);
    }
    const only = this.items[0];
    if (this.items.length === 1 && only && this.chars > MAX_TRANSCRIPT_CHARS) {
      clipItem(only);
      this.chars = itemChars(only);
    }
  }

  get(key: string): TranscriptItem | undefined {
    return this.byKey.get(key);
  }

  delete(key: string): void {
    const item = this.byKey.get(key);
    if (!item) return;
    this.byKey.delete(key);
    const index = this.items.indexOf(item);
    if (index !== -1) this.items.splice(index, 1);
    this.chars -= itemChars(item);
  }

  /** Reposition an item at the chronological end (e.g. queued prompt
   * delivered now). */
  moveToEnd(key: string): void {
    const item = this.byKey.get(key);
    if (!item) return;
    const index = this.items.indexOf(item);
    if (index === -1 || index === this.items.length - 1) return;
    this.items.splice(index, 1);
    this.items.push(item);
  }

  snapshot(): readonly TranscriptItem[] {
    return this.items;
  }
}

function clippedLine(value: string, max = MAX_TOOL_LABEL_CHARS): string {
  const line = value.replaceAll(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function toolLabel(name: string, args: unknown): string {
  if (!isRecord(args)) return name;
  for (const key of ["command", "path", "query", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return `${name}: ${clippedLine(value)}`;
    }
  }
  return name;
}

function toolOutput(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const text = value.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
  if (!text) return undefined;
  return text.length <= MAX_TOOL_OUTPUT_CHARS
    ? text
    : `… output truncated …\n${text.slice(-MAX_TOOL_OUTPUT_CHARS)}`;
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
    if (part.thinking !== undefined && typeof part.thinking !== "string") {
      throw new Error("Invalid assistant thinking from delegated pi");
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

function userMessageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function messageText(message: AssistantMessage): string {
  const chunks: string[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string")
      chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

/** The headline from one provider-supplied thinking block. */
function reasoningSummaryHeadline(
  thinking: string,
  complete: boolean,
): string | undefined {
  const lines = thinking.split("\n");
  if (!complete && !thinking.endsWith("\n")) lines.pop();
  const completeLines = lines.map((part) => part.trim()).filter(Boolean);
  const line =
    completeLines.find((part) =>
      /^(?:#{1,6}\s+|\*\*.+\*\*$|__.+__$)/.test(part),
    ) ?? completeLines[0];
  if (!line) return undefined;
  return clippedLine(
    line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .replace(/^__(.+)__$/, "$1"),
  );
}

function messageReasoningSummary(
  message: AssistantMessage,
): string | undefined {
  const thinking = (message.content ?? [])
    .flatMap((part) =>
      part.type === "thinking" && typeof part.thinking === "string"
        ? [part.thinking]
        : [],
    )
    .at(-1);
  return thinking === undefined
    ? undefined
    : reasoningSummaryHeadline(thinking, true);
}

function writeSpawnFiles(
  agentName: string,
  schema: unknown,
  prompt?: string,
): { dir: string; schemaFilePath: string; promptFilePath?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
  try {
    const schemaFilePath = path.join(dir, `result-schema-${safeName}.json`);
    fs.writeFileSync(schemaFilePath, JSON.stringify(schema), {
      encoding: "utf-8",
      mode: 0o600,
    });
    let promptFilePath: string | undefined;
    if (prompt) {
      promptFilePath = path.join(dir, `append-system-${safeName}.md`);
      fs.writeFileSync(promptFilePath, prompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { dir, schemaFilePath, promptFilePath };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
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
  summaryDebounceMs?: number;
  /** Test hook for loading provider fixtures in delegated processes. */
  extraExtensionPaths?: string[];
}): SpawnEngine {
  const spawnProcess = options?.spawnProcess ?? spawn;
  const terminateAfterMs = options?.terminateAfterMs ?? TERMINATE_AFTER_MS;
  const forceKillAfterMs = options?.forceKillAfterMs ?? FORCE_KILL_AFTER_MS;
  const summaryDebounceMs = options?.summaryDebounceMs ?? SUMMARY_DEBOUNCE_MS;

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
      let submissionAccepted = false;
      let submitNudgeSent = false;
      let settleHolds = 0;
      let resultValue: unknown;
      let agentErrorReason: string | undefined;

      const usage: SpawnUsage = emptyUsage();
      let latestText = "";
      /** Tools currently executing, in start order (they can overlap). */
      const activeTools = new Map<string, string>();
      const transcriptStore = new TranscriptStore();
      /** Injected prompts display their original text in the live transcript,
       * while the child receives a supervisor wrapper. Match delivery events
       * back to the original transcript item through this map. */
      const queuedPromptDeliveries = new Map<string, string>();
      const toolTranscriptKeys = new Map<string, string>();
      const streamedTextBlocks = new Map<number, string>();
      const streamedThinkingBlocks = new Map<number, string>();
      let latestSummary: string | undefined;
      let pendingSummary: string | undefined;
      let summaryTimer: ReturnType<typeof setTimeout> | undefined;
      let activitySequence = 0;
      let currentAssistantEntry: string | undefined;
      let turnsStarted = 0;
      let lastStreamPushAt = 0;
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let observedModel: string | undefined;
      let resolvedModel = spec.model;
      const plannedProvider = spec.model?.includes("/")
        ? spec.model.slice(0, spec.model.indexOf("/"))
        : undefined;
      let stderr = "";
      let buffered = "";
      const decoder = new StringDecoder("utf8");
      const pendingCommands = new Map<string, PendingCommand>();
      let requestId = 0;

      const args: string[] = [
        "--mode",
        "rpc",
        "--extension",
        RESULT_TOOL_EXTENSION_PATH,
      ];
      // Delegated agents write real pi sessions into a pi-agents-owned
      // directory (never the project's default store, which would flood the
      // session picker). Finished agents stay attachable via that file.
      if (spec.sessionDir) {
        fs.mkdirSync(spec.sessionDir, { recursive: true });
        args.push("--session-dir", spec.sessionDir);
      } else {
        args.push("--no-session");
      }
      for (const extensionPath of options?.extraExtensionPaths ?? []) {
        args.push("--extension", extensionPath);
      }
      if (spec.model) args.push("--model", spec.model);
      if (spec.thinking) args.push("--thinking", spec.thinking);
      if (spec.disableSkillDiscovery) args.push("--no-skills");
      // The result-submission tool is mandatory even when the working-tool
      // allowlist is explicitly empty.
      if (spec.tools) {
        const tools = [...new Set([...spec.tools, RESULT_TOOL_NAME])];
        args.push("--tools", tools.join(","));
      }
      const schema = validateJsonSchema(
        effectiveResultSchema(spec.resultSchema),
      );
      const spawnFiles = writeSpawnFiles(
        spec.agent,
        schema,
        spec.systemPrompt?.trim() || undefined,
      );
      tempDir = spawnFiles.dir;
      const holdFilePath = path.join(spawnFiles.dir, "attach-hold");
      if (spawnFiles.promptFilePath) {
        args.push("--append-system-prompt", spawnFiles.promptFilePath);
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
        if (summaryTimer) clearTimeout(summaryTimer);
        terminateTimer = undefined;
        forceKillTimer = undefined;
        summaryTimer = undefined;
        pendingSummary = undefined;
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

      /** One bounded in-band recovery: a settled agent that produced work
       * but never called the result tool gets told to submit what it already
       * has, instead of being reaped into an unsubmitted-result failure.
       * Returns true when the nudge was sent. */
      const requestSubmission = (): boolean => {
        if (submitNudgeSent || wasAborted || settled || stdinEnded)
          return false;
        // Nothing to package, or the turn itself failed: reap normally.
        if (!latestText) return false;
        if (stopReason === "error" || stopReason === "aborted") return false;
        submitNudgeSent = true;
        transcriptStore.upsert({
          key: `notice:${++activitySequence}`,
          kind: "notice",
          notice: "submission-requested",
          text: "No result submitted: requesting submission",
          at: Date.now(),
        });
        pushUpdate();
        void sendCommand({
          type: "prompt",
          message:
            "You finished without submitting a result. Call the result " +
            "submission tool now with your complete result. Do not redo the " +
            "assignment; package the work you already produced.",
        }).catch(() => {
          if (!stdinEnded && !settled) endStdin();
        });
        return true;
      };

      const pushUpdate = () => {
        lastStreamPushAt = Date.now();
        let currentTool: string | undefined;
        for (const name of activeTools.values()) {
          if (name !== RESULT_TOOL_NAME) currentTool = name;
        }
        updates.push({
          text: latestText,
          summary: latestSummary,
          model: observedModel,
          usage: { ...usage },
          currentTool,
          turnsStarted,
        });
      };

      const flushPendingSummary = () => {
        summaryTimer = undefined;
        const pending = pendingSummary;
        pendingSummary = undefined;
        if (!pending || pending === latestSummary) return;
        latestSummary = pending;
        if (currentAssistantEntry) {
          const item = transcriptStore.get(currentAssistantEntry);
          if (item?.kind === "assistant") {
            transcriptStore.upsert({ ...item, summary: pending });
          }
        }
        pushUpdate();
      };

      /** Coalesce streamed fragments before publishing the newest headline. */
      const queueSummary = (summary: string) => {
        if (summary === latestSummary || summary === pendingSummary) return;
        pendingSummary = summary;
        if (summaryTimer) clearTimeout(summaryTimer);
        if (summaryDebounceMs <= 0) {
          flushPendingSummary();
          return;
        }
        summaryTimer = setTimeout(flushPendingSummary, summaryDebounceMs);
        summaryTimer.unref?.();
      };

      const updateAssistantItem = (
        text: string,
        raw?: { message?: unknown; streaming?: boolean },
      ) => {
        if (!text) return;
        currentAssistantEntry ??= `assistant:${++activitySequence}`;
        const existing = transcriptStore.get(currentAssistantEntry);
        const prior = existing?.kind === "assistant" ? existing : undefined;
        const thinking = [...streamedThinkingBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => block)
          .join("\n")
          .trim();
        transcriptStore.upsert({
          key: currentAssistantEntry,
          kind: "assistant",
          text,
          summary: prior?.summary,
          message: raw?.message ?? prior?.message,
          thinking: thinking || prior?.thinking,
          streaming: raw?.streaming ?? true,
          turn: Math.max(1, turnsStarted),
          at: existing?.at ?? Date.now(),
        });
      };

      /**
       * Capture in-flight assistant text and provider-supplied reasoning
       * summaries. Malformed partials are skipped rather than failing the
       * protocol.
       */
      const recordPartialMessage = (record: Record<string, unknown>) => {
        const event = record.assistantMessageEvent;
        if (!isRecord(event)) return;
        const contentIndex = event.contentIndex;
        if (
          typeof contentIndex !== "number" ||
          !Number.isInteger(contentIndex) ||
          contentIndex < 0
        ) {
          return;
        }

        if (event.type === "thinking_start") {
          streamedThinkingBlocks.set(contentIndex, "");
          return;
        }
        if (
          event.type === "thinking_delta" &&
          typeof event.delta === "string"
        ) {
          streamedThinkingBlocks.set(
            contentIndex,
            (streamedThinkingBlocks.get(contentIndex) ?? "") + event.delta,
          );
        } else if (
          event.type === "thinking_end" &&
          typeof event.content === "string"
        ) {
          streamedThinkingBlocks.set(contentIndex, event.content);
        } else if (event.type === "text_start") {
          streamedTextBlocks.set(contentIndex, "");
          return;
        } else if (
          event.type === "text_delta" &&
          typeof event.delta === "string"
        ) {
          streamedTextBlocks.set(
            contentIndex,
            (streamedTextBlocks.get(contentIndex) ?? "") + event.delta,
          );
        } else if (
          event.type === "text_end" &&
          typeof event.content === "string"
        ) {
          streamedTextBlocks.set(contentIndex, event.content);
        } else {
          return;
        }

        if (
          typeof event.type === "string" &&
          event.type.startsWith("thinking_")
        ) {
          const thinking = [...streamedThinkingBlocks.entries()]
            .sort(([left], [right]) => left - right)
            .at(-1)?.[1];
          const summary =
            thinking === undefined
              ? undefined
              : reasoningSummaryHeadline(
                  thinking,
                  event.type === "thinking_end",
                );
          if (summary !== undefined) queueSummary(summary);
          return;
        }

        const text = [...streamedTextBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => block)
          .join("\n")
          .trim();
        if (!text) return;
        const startsNewEntry = currentAssistantEntry === undefined;
        if (text === latestText && !startsNewEntry) return;
        latestText = text;
        updateAssistantItem(text);
        // Deltas arrive far faster than anyone can read; cap intermediate
        // tail snapshots and update fan-out. The close path flushes the last
        // delta when no message_end arrives.
        if (Date.now() - lastStreamPushAt >= STREAM_PUSH_INTERVAL_MS) {
          pushUpdate();
        }
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
          if (message.model) {
            observedModel = message.model.includes("/")
              ? message.model
              : message.provider
                ? `${message.provider}/${message.model}`
                : plannedProvider
                  ? `${plannedProvider}/${message.model}`
                  : message.model;
            resolvedModel = observedModel;
          }
          if (message.stopReason) stopReason = message.stopReason;
          if (message.errorMessage) errorMessage = message.errorMessage;
          const text = messageText(message);
          if (text) {
            latestText = text;
            updateAssistantItem(text, { message, streaming: false });
          }
          const summary = messageReasoningSummary(message);
          if (summary !== undefined) queueSummary(summary);
          streamedTextBlocks.clear();
          streamedThinkingBlocks.clear();
          currentAssistantEntry = undefined;
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
            streamedTextBlocks.clear();
            streamedThinkingBlocks.clear();
            currentAssistantEntry = undefined;
            // The previous turn's outcome (e.g. a user interrupt's "aborted")
            // must not describe this turn: a later process exit would blame
            // a stale reason otherwise.
            stopReason = undefined;
            errorMessage = undefined;
            pushUpdate();
          }
          if (
            record.type === "message_start" &&
            isRecord(record.message) &&
            record.message.role === "assistant"
          ) {
            streamedTextBlocks.clear();
            streamedThinkingBlocks.clear();
          }
          // A user message starting means the child delivered a queued
          // prompt (pi removes it from its steering queue at this moment);
          // confirm the matching transcript item, FIFO.
          if (
            record.type === "message_start" &&
            isRecord(record.message) &&
            record.message.role === "user"
          ) {
            const delivered = userMessageText(record.message);
            const injected = [...queuedPromptDeliveries].find(
              ([, wireText]) => wireText === delivered,
            );
            const match = injected
              ? transcriptStore.get(injected[0])
              : transcriptStore
                  .snapshot()
                  .find(
                    (item) =>
                      item.kind === "user" &&
                      item.queued === true &&
                      item.text === delivered,
                  );
            if (injected) queuedPromptDeliveries.delete(injected[0]);
            if (match?.kind === "user") {
              transcriptStore.upsert({ ...match, queued: false });
              // Delivery is the message's true chronological position: the
              // child appends it to its context now, after everything the
              // current turn streamed since the prompt was accepted.
              transcriptStore.moveToEnd(match.key);
              pushUpdate();
            }
          }
          if (record.type === "message_update") {
            recordPartialMessage(record);
          }
          if (
            record.type === "tool_execution_start" &&
            typeof record.toolCallId === "string" &&
            typeof record.toolName === "string"
          ) {
            activeTools.set(record.toolCallId, record.toolName);
            // The mandatory result-submission tool is engine plumbing, not
            // agent activity; keep it out of the transcript.
            if (record.toolName !== RESULT_TOOL_NAME) {
              const key = `tool:${++activitySequence}`;
              toolTranscriptKeys.set(record.toolCallId, key);
              transcriptStore.upsert({
                key,
                kind: "tool",
                label: toolLabel(record.toolName, record.args),
                status: "running",
                toolName: record.toolName,
                toolCallId: record.toolCallId,
                args: record.args,
                at: Date.now(),
              });
            }
            pushUpdate();
          }
          if (
            record.type === "tool_execution_update" &&
            typeof record.toolCallId === "string"
          ) {
            const key = toolTranscriptKeys.get(record.toolCallId);
            const item = key ? transcriptStore.get(key) : undefined;
            const output = toolOutput(record.partialResult);
            if (
              item?.kind === "tool" &&
              output &&
              Date.now() - lastStreamPushAt >= STREAM_PUSH_INTERVAL_MS
            ) {
              transcriptStore.upsert({
                ...item,
                output,
                result: record.partialResult,
              });
              pushUpdate();
            }
          }
          if (
            record.type === "tool_execution_end" &&
            typeof record.toolCallId === "string"
          ) {
            const toolName = activeTools.get(record.toolCallId);
            if (toolName === RESULT_TOOL_NAME && record.isError === true) {
              // The attach-hold gate (or a schema rejection) bounced the
              // submission. The attempt is engine plumbing, but its refusal
              // must be visible or the conversation reads as broken.
              const last = transcriptStore.snapshot().at(-1);
              transcriptStore.upsert({
                key:
                  last?.kind === "notice"
                    ? last.key
                    : `notice:${++activitySequence}`,
                kind: "notice",
                notice: "submission-deferred",
                text: "Submission deferred: detach to finish",
                at: Date.now(),
              });
              pushUpdate();
            }
            if (toolName === RESULT_TOOL_NAME && record.isError !== true) {
              if (submissionAccepted) {
                throw new Error(
                  "Delegated agent submitted more than one result.",
                );
              }
              if (
                !isRecord(record.result) ||
                !isRecord(record.result.details)
              ) {
                throw new Error(
                  "Delegated agent result submission completed without an envelope.",
                );
              }
              const details = record.result.details;
              const detailKeys = Object.keys(details);
              if (detailKeys.length === 1 && Object.hasOwn(details, "result")) {
                resultValue = details.result;
              } else if (
                detailKeys.length === 1 &&
                isRecord(details.error) &&
                Object.keys(details.error).length === 1 &&
                typeof details.error.reason === "string" &&
                details.error.reason.length > 0
              ) {
                agentErrorReason = details.error.reason;
              } else {
                throw new Error(
                  "Delegated agent result submission completed with an invalid envelope.",
                );
              }
              submissionAccepted = true;
              // Result submission is engine plumbing and filtered from the
              // transcript; leave a visible marker so an attached user sees
              // that the agent finished (and with what).
              const preview =
                agentErrorReason !== undefined
                  ? `error: ${clippedLine(agentErrorReason, 120)}`
                  : typeof resultValue === "string"
                    ? clippedLine(resultValue, 120)
                    : clippedLine(JSON.stringify(resultValue) ?? "", 120);
              transcriptStore.upsert({
                key: `notice:${++activitySequence}`,
                kind: "notice",
                notice: "result-submitted",
                text: `Result submitted${preview ? `: ${preview}` : ""}`,
                at: Date.now(),
              });
            }
            activeTools.delete(record.toolCallId);
            const key = toolTranscriptKeys.get(record.toolCallId);
            const item = key ? transcriptStore.get(key) : undefined;
            if (item?.kind === "tool") {
              transcriptStore.upsert({
                ...item,
                output: toolOutput(record.result),
                status: record.isError === true ? "error" : "ok",
                result: record.result,
              });
              toolTranscriptKeys.delete(record.toolCallId);
            }
            pushUpdate();
          }
          if (record.type === "agent_start") {
            agentStarted = true;
            // A held spawn can be re-prompted after an idle settle; a new
            // agent run un-settles it.
            agentSettled = false;
          }
          if (record.type === "agent_settled" && !agentSettled) {
            agentSettled = true;
            // While held by an attached user, an idle settle without a
            // result keeps the child alive for follow-up prompts. A settle
            // after result submission always ends the spawn: the node's work
            // is done and the workflow must not wait on the attachment.
            if (submissionAccepted) {
              endStdin();
            } else if (settleHolds === 0 && !requestSubmission()) {
              // No recovery available (or already attempted); the close
              // path preserves the final response as the raw result.
              endStdin();
            }
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
          env: {
            ...process.env,
            ...(spec.env ?? {}),
            [RESULT_SCHEMA_FILE_ENV_VAR]: spawnFiles.schemaFilePath,
            [RESULT_HOLD_FILE_ENV_VAR]: holdFilePath,
          },
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
          if (currentAssistantEntry !== undefined) {
            updateAssistantItem(latestText);
            pushUpdate();
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
          if (
            terminalFailure === undefined &&
            agentSettled &&
            stopReason !== "error" &&
            stopReason !== "aborted" &&
            (exitCode === 0 || sentTerminationSignal) &&
            !submissionAccepted
          ) {
            status = "failed";
            cleanup();
            rejectWait(
              new UnsubmittedResult(spec.agent, latestText, exitCode, stderr),
            );
            return;
          }
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

          if (agentErrorReason !== undefined) {
            status = "failed";
            cleanup();
            rejectWait(new AgentErrorResult(spec.agent, agentErrorReason));
            return;
          }

          status = "completed";
          cleanup();
          resolveWait({
            value: resultValue,
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

      transcriptStore.upsert({
        key: "user:task",
        kind: "user",
        text: spec.task,
        queued: true,
        at: Date.now(),
      });

      let resolveNativeSession!: (file: string | undefined) => void;
      const nativeSession = new Promise<string | undefined>((resolve) => {
        resolveNativeSession = resolve;
      });

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
            const state = await sendCommand({ type: "get_state" });
            const data = state.data;
            if (
              spec.sessionDir &&
              isRecord(data) &&
              typeof data.sessionFile === "string"
            ) {
              resolveNativeSession(data.sessionFile);
            } else {
              resolveNativeSession(undefined);
            }
            if (!agentStarted && !agentSettled && idleRpcState(data)) {
              throw new Error(
                "Delegated pi accepted the prompt without starting an agent run",
              );
            }
          })()
        : Promise.reject(new Error("Delegated pi RPC process did not start"));

      startupPromise.catch((error) => {
        resolveNativeSession(undefined);
        if (wasAborted || settled) return;
        failProtocol(
          `Failed to initialize delegated pi RPC process: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      let injectedPrompts = 0;
      return {
        get status() {
          return status;
        },
        updates,
        wait: () => waitPromise,
        nativeSession,
        transcript: () => transcriptStore.snapshot(),
        prompt: async (message: string) => {
          await startupPromise;
          // A submitted result ends the conversation: the node's work is
          // done even while the process is still shutting down.
          if (submissionAccepted) {
            throw new Error(`Agent ${spec.agent} already submitted its result`);
          }
          if (
            wasAborted ||
            settled ||
            status !== "running" ||
            (agentSettled && settleHolds === 0)
          ) {
            throw new Error(`Agent ${spec.agent} is no longer running`);
          }
          // Record the prompt before writing it. For an idle child, Pi can
          // emit the user message_start immediately after the RPC response,
          // before this promise resumes; the delivery event must have a
          // queued item available to confirm.
          const transcriptKey = `user:${++injectedPrompts}`;
          const wireMessage = attachedSupervisorPrompt(message);
          transcriptStore.upsert({
            key: transcriptKey,
            kind: "user",
            text: message,
            queued: true,
            at: Date.now(),
          });
          queuedPromptDeliveries.set(transcriptKey, wireMessage);
          pushUpdate();
          try {
            await Promise.race([
              sendCommand({
                type: "prompt",
                message: wireMessage,
                streamingBehavior: "steer",
              }),
              waitPromise.then(
                () => Promise.reject(new Error(`Agent ${spec.agent} settled`)),
                () => Promise.reject(new Error(`Agent ${spec.agent} settled`)),
              ),
            ]);
          } catch (error) {
            // Roll back a prompt that Pi rejected. Preserve it if a racing
            // message_start already confirmed delivery.
            const item = transcriptStore.get(transcriptKey);
            if (item?.kind === "user" && item.queued === true) {
              queuedPromptDeliveries.delete(transcriptKey);
              transcriptStore.delete(transcriptKey);
              pushUpdate();
            }
            throw error;
          }
        },
        interrupt: async () => {
          await startupPromise;
          if (wasAborted || settled || status !== "running") return;
          // Mirror the interactive session's Esc feedback at press time —
          // before the abort round-trip, so an in-flight reply cannot slot
          // in ahead of the marker: mark still-running tool calls as cut
          // off and leave the interrupt marker immediately.
          for (const key of toolTranscriptKeys.values()) {
            const item = transcriptStore.get(key);
            if (item?.kind === "tool" && item.status === "running") {
              transcriptStore.upsert({ ...item, status: "error" });
            }
          }
          toolTranscriptKeys.clear();
          // Repeated Esc presses coalesce onto one marker instead of
          // stacking a line per keypress. An interrupt strands queued
          // steering (nothing runs to deliver it until the next turn);
          // say so instead of letting messages silently disappear.
          const stranded = transcriptStore
            .snapshot()
            .filter(
              (item) => item.kind === "user" && item.queued === true,
            ).length;
          const last = transcriptStore.snapshot().at(-1);
          transcriptStore.upsert({
            key:
              last?.kind === "notice"
                ? last.key
                : `notice:${++activitySequence}`,
            kind: "notice",
            notice: "interrupted",
            text:
              stranded > 0
                ? `Interrupted: ${stranded} ${stranded === 1 ? "message remains" : "messages remain"} queued`
                : "Interrupted: send a message to continue",
            at: Date.now(),
          });
          pushUpdate();
          await sendCommand({ type: "abort" });
        },
        held: () => settleHolds > 0,
        hold: () => {
          settleHolds += 1;
          if (settleHolds === 1) {
            try {
              fs.writeFileSync(holdFilePath, "1");
            } catch {
              // Without the file the child simply is not gated.
            }
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            settleHolds -= 1;
            if (settleHolds > 0) return;
            try {
              fs.rmSync(holdFilePath, { force: true });
            } catch {
              // Removal failures only mean the gate stays until exit.
            }
            if (stdinEnded || settled || wasAborted) return;
            if (!agentSettled) return;
            if (submissionAccepted) {
              endStdin();
              return;
            }
            // The gate may have blocked the agent's submission attempts; a
            // settled, resultless agent gets one nudge to finish instead of
            // being reaped into a "finished without a result" failure.
            submitNudgeSent = true;
            transcriptStore.upsert({
              key: `notice:${++activitySequence}`,
              kind: "notice",
              notice: "detached",
              text: "Detached: finishing assignment",
              at: Date.now(),
            });
            void sendCommand({
              type: "prompt",
              message:
                "The supervising user detached. Complete the assignment now and submit your result.",
            }).catch(() => {
              if (!stdinEnded && !settled) endStdin();
            });
          };
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
