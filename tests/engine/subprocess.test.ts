import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import {
  RESULT_SCHEMA_FILE_ENV_VAR,
  RESULT_TOOL_NAME,
} from "../../src/engine/result-tool.js";
import {
  createSubprocessSpawnEngine,
  formatFailureReason,
  isChildProcessRunning,
  MAX_ACTIVITY_TAIL_CHARS,
  type SpawnProcess,
} from "../../src/engine/subprocess.js";
import {
  AgentErrorResult,
  SpawnAborted,
  SpawnFailure,
} from "../../src/engine/types.js";

class FakeStdin extends EventEmitter {
  readonly records: Array<Record<string, unknown>> = [];
  ended = false;
  onRecord?: (record: Record<string, unknown>) => void;

  write(data: string): boolean {
    for (const line of data.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      this.records.push(record);
      this.onRecord?.(record);
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

interface FakeProcOptions {
  promptStartsAgent?: boolean;
  promptPrelude?: Array<Record<string, unknown>>;
  manualGetState?: boolean;
}

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];
  streaming = false;

  constructor(
    failCommand?: string,
    private readonly options: FakeProcOptions = {},
  ) {
    super();
    this.stdin.onRecord = (record) => {
      if (typeof record.id !== "string" || typeof record.type !== "string")
        return;
      if (record.type === "get_state" && this.options.manualGetState) return;
      queueMicrotask(() => {
        if (record.type === "prompt") {
          for (const event of this.options.promptPrelude ?? []) {
            this.emitRecord(event);
          }
        }
        const commandSucceeded = record.type !== failCommand;
        this.emitRecord({
          type: "response",
          id: record.id,
          command: record.type,
          success: commandSucceeded,
          ...(record.type === "get_state"
            ? {
                data: {
                  isStreaming: this.streaming,
                  pendingMessageCount: 0,
                },
              }
            : {}),
          ...(record.type === failCommand
            ? { error: `unsupported ${record.type}` }
            : {}),
        });
        if (
          commandSucceeded &&
          record.type === "prompt" &&
          this.options.promptStartsAgent !== false
        ) {
          this.emitRecord({ type: "agent_start" });
        }
      });
    };
  }

  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  emitRecord(record: Record<string, unknown>, suffix = "\n") {
    if (record.type === "agent_start") this.streaming = true;
    if (record.type === "agent_settled") this.streaming = false;
    this.stdout.emit("data", `${JSON.stringify(record)}${suffix}`);
  }

  emitAssistant(text: string, extra: Record<string, unknown> = {}) {
    this.emitRecord({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 1,
          cacheWrite: 2,
          totalTokens: 18,
          cost: { total: 0.03 },
        },
        model: "test-model",
        ...extra,
      },
    });
  }

  settle() {
    this.emitRecord({ type: "agent_settled" });
  }

  close(code: number, signal: string | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function makeEngine(
  failCommand?: string,
  timings?: {
    terminateAfterMs?: number;
    forceKillAfterMs?: number;
    summaryDebounceMs?: number;
  },
  procOptions?: FakeProcOptions,
) {
  const procs: Array<{
    proc: FakeProc;
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }> = [];
  const spawnProcess = ((
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    const proc = new FakeProc(failCommand, procOptions);
    procs.push({ proc, command, args, options });
    return proc;
  }) as unknown as SpawnProcess;
  return {
    engine: createSubprocessSpawnEngine({ spawnProcess, ...timings }),
    procs,
  };
}

async function ready(proc: FakeProc): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    if (proc.stdin.records.some((record) => record.type === "prompt")) return;
  }
  throw new Error("fake RPC process never received prompt");
}

let resultCallSequence = 0;

function submitResult(proc: FakeProc, value: unknown = "ok"): void {
  const toolCallId = `result-${++resultCallSequence}`;
  proc.emitRecord({
    type: "tool_execution_start",
    toolCallId,
    toolName: RESULT_TOOL_NAME,
    args: { result: value },
  });
  proc.emitRecord({
    type: "tool_execution_end",
    toolCallId,
    toolName: RESULT_TOOL_NAME,
    result: {
      content: [{ type: "text", text: "Agent result accepted." }],
      details: { result: value },
    },
    isError: false,
  });
}

function submitError(proc: FakeProc, reason: string): void {
  const toolCallId = `result-${++resultCallSequence}`;
  proc.emitRecord({
    type: "tool_execution_start",
    toolCallId,
    toolName: RESULT_TOOL_NAME,
    args: { error: { reason } },
  });
  proc.emitRecord({
    type: "tool_execution_end",
    toolCallId,
    toolName: RESULT_TOOL_NAME,
    result: {
      content: [{ type: "text", text: "Agent error accepted." }],
      details: { error: { reason } },
    },
    isError: false,
  });
}

function finish(proc: FakeProc, text = "ok", value: unknown = text): void {
  proc.emitAssistant(text);
  submitResult(proc, value);
  proc.emitRecord({ type: "agent_end", messages: [], willRetry: false });
  proc.settle();
  proc.close(0);
}

describe("subprocess spawn engine", () => {
  test("builds the RPC invocation and initializes before prompting", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "scout",
      task: "find things",
      cwd: "/tmp/x",
      model: "some-model",
      thinking: "low",
      tools: ["read", "grep"],
      env: { [RESULT_SCHEMA_FILE_ENV_VAR]: "/caller/cannot-override.json" },
    });
    const spawned = procs[0] as (typeof procs)[number];
    expect(spawned.command).toBe("pi");
    expect(spawned.args.slice(0, 3)).toEqual(["--mode", "rpc", "--no-session"]);
    expect(spawned.args).not.toContain("-p");
    expect(spawned.args).toContain("some-model");
    expect(spawned.args).toContain("--thinking");
    expect(spawned.args).toContain("--extension");
    expect(spawned.args).toContain("--tools");
    expect(spawned.args).toContain(`read,grep,${RESULT_TOOL_NAME}`);
    const env = spawned.options.env as Record<string, string>;
    const schemaFile = env[RESULT_SCHEMA_FILE_ENV_VAR] as string;
    expect(schemaFile).not.toBe("/caller/cannot-override.json");
    expect(JSON.parse(fs.readFileSync(schemaFile, "utf8"))).toEqual({
      type: "string",
    });

    await ready(spawned.proc);
    expect(spawned.proc.stdin.records.map((record) => record.type)).toEqual([
      "set_steering_mode",
      "prompt",
    ]);
    expect(spawned.proc.stdin.records[0]?.mode).toBe("one-at-a-time");
    expect(spawned.proc.stdin.records[1]?.message).toBe("find things");

    finish(spawned.proc, "hello");
    const outcome = await handle.wait();
    expect(outcome.value).toBe("hello");
    expect(fs.existsSync(schemaFile)).toBe(false);
    expect(outcome.usage.turns).toBe(1);
    expect(outcome.usage.input).toBe(10);
    expect(outcome.usage.cost).toBeCloseTo(0.03);
    expect(outcome.model).toBe("test-model");
    expect(handle.status).toBe("completed");
    expect(spawned.proc.stdin.ended).toBe(true);
  });

  test("tool allowlists preserve empty, omitted, and populated semantics", async () => {
    const empty = makeEngine();
    const emptyHandle = empty.engine.spawn({
      agent: "locked",
      task: "t",
      cwd: "/tmp",
      tools: [],
    });
    expect(empty.procs[0]?.args).not.toContain("--no-tools");
    expect(empty.procs[0]?.args).toContain(RESULT_TOOL_NAME);
    finish(empty.procs[0]?.proc as FakeProc);
    await emptyHandle.wait();

    const open = makeEngine();
    const openHandle = open.engine.spawn({
      agent: "open",
      task: "t",
      cwd: "/tmp",
    });
    expect(open.procs[0]?.args).not.toContain("--no-tools");
    expect(open.procs[0]?.args).not.toContain("--tools");
    finish(open.procs[0]?.proc as FakeProc);
    await openHandle.wait();
  });

  test("closed skill selections disable child discovery", async () => {
    const closed = makeEngine();
    const closedHandle = closed.engine.spawn({
      agent: "closed",
      task: "t",
      cwd: "/tmp",
      disableSkillDiscovery: true,
    });
    expect(closed.procs[0]?.args).toContain("--no-skills");
    finish(closed.procs[0]?.proc as FakeProc);
    await closedHandle.wait();

    const ambient = makeEngine();
    const ambientHandle = ambient.engine.spawn({
      agent: "ambient",
      task: "t",
      cwd: "/tmp",
    });
    expect(ambient.procs[0]?.args).not.toContain("--no-skills");
    finish(ambient.procs[0]?.proc as FakeProc);
    await ambientHandle.wait();
  });

  test("writes the system prompt to a temp file and cleans it up", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "scout",
      task: "t",
      cwd: "/tmp",
      systemPrompt: "You are a scout.",
    });
    const args = procs[0]?.args ?? [];
    const flagIndex = args.indexOf("--append-system-prompt");
    const promptPath = args[flagIndex + 1] as string;
    expect(fs.readFileSync(promptPath, "utf-8")).toBe("You are a scout.");
    finish(procs[0]?.proc as FakeProc);
    await handle.wait();
    expect(fs.existsSync(promptPath)).toBe(false);
  });

  test("agent_end is not completion; agent_settled is", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitAssistant("first");
    proc.emitRecord({ type: "agent_end", messages: [], willRetry: true });
    expect(proc.stdin.ended).toBe(false);
    proc.emitAssistant("second");
    submitResult(proc, "submitted");
    proc.settle();
    expect(proc.stdin.ended).toBe(true);
    proc.close(0);
    const outcome = await handle.wait();
    expect(outcome.value).toBe("submitted");
    expect(outcome.usage.turns).toBe(2);
  });

  test("assistant prose without a submitted result fails", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitAssistant("This is not a submitted result.");
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "Agent w finished without submitting a result.",
    );
  });

  test("a rejected submission can be corrected", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
      resultSchema: {
        type: ["null", "boolean", "number", "string", "array", "object"],
      },
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "rejected",
      toolName: RESULT_TOOL_NAME,
      args: {},
    });
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "rejected",
      toolName: RESULT_TOOL_NAME,
      result: { content: [{ type: "text", text: "Validation failed" }] },
      isError: true,
    });
    const env = procs[0]?.options.env as Record<string, string>;
    expect(
      JSON.parse(
        fs.readFileSync(env[RESULT_SCHEMA_FILE_ENV_VAR] as string, "utf8"),
      ),
    ).toEqual({
      type: ["null", "boolean", "number", "string", "array", "object"],
    });
    submitResult(proc, { ok: true });
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).resolves.toMatchObject({
      value: { ok: true },
    });
  });

  test("a successful submission without details fails the protocol", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "invalid",
      toolName: RESULT_TOOL_NAME,
      args: { result: "result" },
    });
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "invalid",
      toolName: RESULT_TOOL_NAME,
      result: { content: [{ type: "text", text: "accepted" }] },
      isError: false,
    });
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "result submission completed without an envelope",
    );
  });

  test("an accepted error submission rejects with AgentErrorResult", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const proc = procs[0]?.proc as FakeProc;
    submitError(proc, "required context is unavailable");
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toBeInstanceOf(AgentErrorResult);
    await handle.wait().catch((error: AgentErrorResult) => {
      expect(error.agent).toBe("w");
      expect(error.reason).toBe("required context is unavailable");
      expect(error.message).toBe("required context is unavailable");
    });
    expect(handle.status).toBe("failed");
  });

  test("more than one accepted submission fails the protocol", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    submitResult(proc, "first");
    submitResult(proc, "second");
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "submitted more than one result",
    );
  });

  test("accepted extension commands without an agent run fail promptly", async () => {
    const { engine, procs } = makeEngine(undefined, undefined, {
      promptStartsAgent: false,
      promptPrelude: [
        {
          type: "message_end",
          message: {
            role: "custom",
            customType: "noop",
            content: "handled",
          },
        },
      ],
    });
    const handle = engine.spawn({
      agent: "w",
      task: "/noop",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    for (let i = 0; i < 10 && !proc.stdin.ended; i++) {
      await Promise.resolve();
    }
    expect(
      proc.stdin.records.some((record) => record.type === "get_state"),
    ).toBe(true);
    expect(proc.stdin.ended).toBe(true);
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "accepted the prompt without starting an agent run",
    );
  });

  test("handled input events without an agent run fail promptly", async () => {
    const { engine, procs } = makeEngine(undefined, undefined, {
      promptStartsAgent: false,
    });
    const handle = engine.spawn({
      agent: "w",
      task: "handled",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    for (let i = 0; i < 10 && !proc.stdin.ended; i++) {
      await Promise.resolve();
    }
    expect(proc.stdin.ended).toBe(true);
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "accepted the prompt without starting an agent run",
    );
  });

  test("an observed agent start wins a racing idle state response", async () => {
    const { engine, procs } = makeEngine(undefined, undefined, {
      promptStartsAgent: false,
      manualGetState: true,
    });
    const handle = engine.spawn({
      agent: "w",
      task: "fast",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    let getState: Record<string, unknown> | undefined;
    for (let i = 0; i < 10 && !getState; i++) {
      await Promise.resolve();
      getState = proc.stdin.records.find(
        (record) => record.type === "get_state",
      );
    }
    expect(getState).toBeDefined();
    proc.emitRecord({ type: "agent_start" });
    proc.emitRecord({
      type: "response",
      id: getState?.id,
      command: "get_state",
      success: true,
      data: { isStreaming: false, pendingMessageCount: 0 },
    });
    finish(proc, "done");
    await expect(handle.wait()).resolves.toMatchObject({ value: "done" });
  });

  test("settled children that ignore stdin EOF escalate to TERM then KILL", async () => {
    const { engine, procs } = makeEngine(undefined, {
      terminateAfterMs: 1,
      forceKillAfterMs: 1,
    });
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    await ready(proc);
    await Promise.resolve();
    proc.emitAssistant("done");
    submitResult(proc, "done");
    proc.settle();
    expect(proc.stdin.ended).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
    proc.close(0, "SIGKILL");
    await expect(handle.wait()).resolves.toMatchObject({ value: "done" });
  });

  test("failed RPC initialization rejects with the command error", async () => {
    const { engine, procs } = makeEngine("set_steering_mode");
    const handle = engine.spawn({
      agent: "worker",
      task: "t",
      cwd: "/tmp",
    });
    for (let i = 0; i < 10 && !procs[0]?.proc.stdin.ended; i++) {
      await Promise.resolve();
    }
    procs[0]?.proc.close(0);
    await expect(handle.wait()).rejects.toThrow(
      "requires the latest Pi release",
    );
    await expect(handle.wait()).rejects.toThrow('run "pi update pi"');
    await expect(handle.wait()).rejects.toThrow(
      "unsupported set_steering_mode",
    );
  });

  test("nonzero exit before settlement rejects with SpawnFailure", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "worker",
      task: "t",
      cwd: "/tmp",
    });
    procs[0]?.proc.stderr.emit("data", "something broke");
    procs[0]?.proc.close(2);
    await expect(handle.wait()).rejects.toThrow(SpawnFailure);
    await handle.wait().catch((error: SpawnFailure) => {
      expect(error.message).toContain("worker failed");
      expect(error.exitCode).toBe(2);
    });
  });

  test("stopReason error rejects even after settlement", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitAssistant("partial", {
      stopReason: "error",
      errorMessage: "model exploded",
    });
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow("model exploded");
  });

  test("abort uses RPC after readiness and rejects with SpawnAborted", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    await ready(proc);
    await Promise.resolve();
    await Promise.resolve();
    handle.abort();
    expect(proc.stdin.records.some((record) => record.type === "abort")).toBe(
      true,
    );
    proc.settle();
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow(SpawnAborted);
    expect(handle.status).toBe("aborted");
  });

  test("steer waits for readiness and receives correlated acknowledgement", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    await handle.steer?.("change course");
    expect(
      proc.stdin.records.find((record) => record.type === "steer")?.message,
    ).toBe("change course");
    finish(proc);
    await handle.wait();
    await expect(handle.steer?.("too late")).rejects.toThrow(
      "no longer running",
    );
  });

  test("streams progress updates", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.text);
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitAssistant("first");
    proc.emitAssistant("second");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(seen.slice(0, 2)).toEqual(["first", "second"]);
  });

  test("keeps a bounded chronological tail of assistant and tool activity", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const tails: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        if (update.tail) tails.push(update.tail);
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" });
    proc.emitAssistant("I will inspect the tests.");
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    proc.emitRecord({
      type: "tool_execution_update",
      toolCallId: "1",
      toolName: "bash",
      partialResult: {
        content: [{ type: "text", text: "running tests…" }],
      },
    });
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "455 pass" }] },
      isError: false,
    });
    proc.emitRecord({ type: "turn_start" });
    proc.emitAssistant("Everything passes.");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;

    const tail = tails.at(-1) ?? "";
    expect(tail).toContain("assistant · turn 1\nI will inspect the tests.");
    expect(tail).toContain("✓ bash: bun test\n455 pass");
    expect(tail).toContain("assistant · turn 2\nEverything passes.");
    expect(tail.length).toBeLessThanOrEqual(MAX_ACTIVITY_TAIL_CHARS);
  });

  test("bounds a single oversized activity entry", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    let longestTail = "";
    const reader = (async () => {
      for await (const update of handle.updates) {
        if ((update.tail?.length ?? 0) > longestTail.length) {
          longestTail = update.tail ?? longestTail;
        }
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" });
    proc.emitAssistant("x".repeat(MAX_ACTIVITY_TAIL_CHARS + 1_000));
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(longestTail.length).toBe(MAX_ACTIVITY_TAIL_CHARS);
    expect(longestTail).toStartWith("… earlier activity omitted …\n");
  });

  test("strict JSONL preserves chunking, CRLF, and Unicode separators", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    const text = "chunked still-one-line done";
    const line = `${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    })}\r\n`;
    const bytes = Buffer.from(line);
    const mid = bytes.indexOf(Buffer.from(" ")) + 1;
    proc.stdout.emit("data", bytes.subarray(0, mid));
    proc.stdout.emit("data", bytes.subarray(mid));
    submitResult(proc, text);
    proc.settle();
    proc.close(0);
    const outcome = await handle.wait();
    expect(outcome.value).toBe(text);
  });

  test("blocking extension UI requests are cancelled", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
      title: "Question",
    });
    expect(proc.stdin.records).toContainEqual({
      type: "extension_ui_response",
      id: "dialog-1",
      cancelled: true,
    });
    finish(proc);
    await handle.wait();
  });

  test("malformed RPC output fails the spawn", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    proc.settle();
    proc.stdout.emit("data", "{broken");
    proc.close(0);
    await expect(handle.wait()).rejects.toThrow("Invalid JSON");
  });

  test("malformed assistant content fails only the delegated spawn", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const proc = procs[0]?.proc as FakeProc;
    expect(() =>
      proc.emitRecord({
        type: "message_end",
        message: { role: "assistant", content: { type: "text" } },
      }),
    ).not.toThrow();
    expect(proc.stdin.ended).toBe(true);
    expect(() => proc.close(0)).not.toThrow();
    await expect(handle.wait()).rejects.toThrow(
      "Invalid assistant message content",
    );
  });
});

describe("failure formatting", () => {
  test("strips stack traces", () => {
    const raw =
      "Error: kaput\n    at foo (file:///x.ts:1:1)\n    at bar\nfile:///y.ts";
    expect(formatFailureReason(raw)).toBe("Error: kaput");
  });

  test("detects missing API keys", () => {
    expect(
      formatFailureReason("No API key found for anthropic.", "some-model"),
    ).toContain('No credentials configured for provider "anthropic"');
  });

  test("isChildProcessRunning", () => {
    expect(isChildProcessRunning({ exitCode: null, signalCode: null })).toBe(
      true,
    );
    expect(isChildProcessRunning({ exitCode: 0, signalCode: null })).toBe(
      false,
    );
  });
});

describe("turn and tool activity", () => {
  test("turn_start and tool execution events stream as updates", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: Array<{ turnsStarted?: number; currentTool?: string }> = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        seen.push({
          turnsStarted: update.turnsStarted,
          currentTool: update.currentTool,
        });
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" });
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "bash",
      args: {},
    });
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "bash",
      result: {},
      isError: false,
    });
    proc.emitAssistant("worked");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(seen.slice(0, 4)).toEqual([
      { turnsStarted: 1, currentTool: undefined },
      { turnsStarted: 1, currentTool: "bash" },
      { turnsStarted: 1, currentTool: undefined },
      { turnsStarted: 1, currentTool: undefined },
    ]);
    expect(
      seen.some(({ currentTool }) => currentTool === RESULT_TOOL_NAME),
    ).toBe(false);
  });

  test("completed turns back up turnsStarted for older engines", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: number[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        seen.push(update.turnsStarted ?? -1);
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitAssistant("one");
    proc.emitAssistant("two");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(seen.slice(0, 2)).toEqual([1, 2]);
  });
});

describe("reasoning summaries", () => {
  test("streams Pi thinking events as the newest summary headline", async () => {
    const { engine, procs } = makeEngine(undefined, {
      summaryDebounceMs: 1,
    });
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        if (update.summary) seen.push(update.summary);
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "**Refining README widget description**\n\n",
      },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content:
          "**Refining README widget description**\n\n**Simplifying live summary widget text**",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitAssistant("done");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(seen).toContain("Refining README widget description");
    expect(seen).not.toContain("Simplifying live summary widget text");
  });

  test("ignores partial lines and keeps a thinking block's headline", async () => {
    const { engine, procs } = makeEngine(undefined, {
      summaryDebounceMs: 1,
    });
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        if (update.summary && update.summary !== seen.at(-1)) {
          seen.push(update.summary);
        }
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    const delta = (value: string) =>
      proc.emitRecord({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: value,
        },
      });

    delta("**Deciding on");
    await new Promise((resolve) => setTimeout(resolve, 3));
    delta(" the widget fix**");
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(seen).toEqual([]);
    delta("\n\nI ne");
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(seen).toEqual(["Deciding on the widget fix"]);
    delta("ed to check src/ui/widget.ts");
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(seen).toEqual(["Deciding on the widget fix"]);
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content:
          "**Deciding on the widget fix**\n\nI need to check src/ui/widget.ts",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(seen).toEqual(["Deciding on the widget fix"]);

    proc.emitAssistant("done");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
  });

  test("debounces rapid headlines and keeps the last one across turns", async () => {
    const { engine, procs } = makeEngine(undefined, {
      summaryDebounceMs: 5,
    });
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const seen: string[] = [];
    let previous: string | undefined;
    const reader = (async () => {
      for await (const update of handle.updates) {
        if (update.summary && update.summary !== previous) {
          previous = update.summary;
          seen.push(update.summary);
        }
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    const emitSummary = (summary: string) =>
      proc.emitRecord({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: `**${summary}**`,
        },
      });

    emitSummary("First headline");
    await new Promise((resolve) => setTimeout(resolve, 10));
    proc.emitRecord({ type: "turn_start" });
    emitSummary("Skipped headline");
    emitSummary("Latest headline");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["First headline", "Latest headline"]);

    proc.emitAssistant("done");
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
  });
});

describe("overlapping tools and streamed text", () => {
  test("concurrent tool executions correlate by toolCallId", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: Array<string | undefined> = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.currentTool);
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "bash",
      args: {},
    });
    proc.emitRecord({
      type: "tool_execution_start",
      toolCallId: "2",
      toolName: "read",
      args: {},
    });
    // Ending the FIRST tool must not clear the still-running second one.
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "bash",
      result: {},
      isError: false,
    });
    proc.emitRecord({
      type: "tool_execution_end",
      toolCallId: "2",
      toolName: "read",
      result: {},
      isError: false,
    });
    submitResult(proc, "result");
    proc.settle();
    proc.close(0);
    await handle.wait();
    await reader;
    expect(seen.slice(0, 4)).toEqual(["bash", "read", "read", undefined]);
  });

  test("message_update streams in-flight text, throttled", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.text);
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    const partial = (delta: string) =>
      proc.emitRecord({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    partial("half an");
    partial(" answer"); // within the throttle window: not pushed
    proc.emitAssistant("the full answer");
    submitResult(proc, "submitted answer");
    proc.settle();
    proc.close(0);
    const outcome = await handle.wait();
    await reader;
    expect(seen.slice(0, 2)).toEqual(["half an", "the full answer"]);
    expect(outcome.value).toBe("submitted answer");
  });

  test("orders text blocks and trusts text_end content", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.text);
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" }); // keeps deltas throttled until close
    proc.emitRecord({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 2 },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 2,
        delta: "tail draft",
      },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "head",
      },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 2,
        content: "tail final",
      },
    });
    proc.close(2);

    await expect(handle.wait()).rejects.toThrow(SpawnFailure);
    await reader;
    expect(seen.at(-1)).toBe("head\ntail final");
  });

  test("resets streamed blocks between assistant messages", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.text);
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" });
    proc.emitRecord({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "first partial",
      },
    });
    proc.emitAssistant("first final");
    proc.emitRecord({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "second partial",
      },
    });
    proc.close(2);

    await expect(handle.wait()).rejects.toThrow(SpawnFailure);
    await reader;
    expect(seen.at(-1)).toBe("second partial");
  });

  test("flushes the newest assistant tail when the stream is cut off", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "w",
      task: "t",
      cwd: "/tmp",
    });
    const tails: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) {
        if (update.tail) tails.push(update.tail);
      }
    })();
    const proc = procs[0]?.proc as FakeProc;
    proc.emitRecord({ type: "turn_start" }); // starts the throttle window
    proc.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    const partial = (delta: string) =>
      proc.emitRecord({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    partial("half an");
    partial(" answer"); // throttled, then flushed by close
    proc.close(2);

    await expect(handle.wait()).rejects.toThrow(SpawnFailure);
    await reader;
    expect(tails.at(-1)).toContain("assistant · turn 1\nhalf an answer");
  });
});
