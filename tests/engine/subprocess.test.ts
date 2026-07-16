import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import {
  createSubprocessSpawnEngine,
  formatFailureReason,
  isChildProcessRunning,
  type SpawnProcess,
} from "../../src/engine/subprocess.js";
import { SpawnAborted, SpawnFailure } from "../../src/engine/types.js";

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinData = "";
  stdin = {
    end: (data?: string) => {
      this.stdinData = data ?? "";
    },
  };
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];

  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  emitAssistant(text: string, extra: Record<string, unknown> = {}) {
    const event = {
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
    };
    this.stdout.emit("data", `${JSON.stringify(event)}\n`);
  }

  close(code: number, signal: string | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function makeEngine() {
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
    const proc = new FakeProc();
    procs.push({ proc, command, args, options });
    return proc;
  }) as unknown as SpawnProcess;
  return { engine: createSubprocessSpawnEngine({ spawnProcess }), procs };
}

describe("subprocess spawn engine", () => {
  test("builds the pi invocation and pipes the task on stdin", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({
      agent: "scout",
      task: "find things",
      cwd: "/tmp/x",
      model: "some-model",
      thinking: "low",
      tools: ["read", "grep"],
    });
    const spawned = procs[0];
    expect(spawned?.command).toBe("pi");
    expect(spawned?.args.slice(0, 4)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
    ]);
    expect(spawned?.args).toContain("--model");
    expect(spawned?.args).toContain("some-model");
    expect(spawned?.args).toContain("--thinking");
    expect(spawned?.args).toContain("--tools");
    expect(spawned?.args).toContain("read,grep");
    expect(spawned?.proc.stdinData).toBe("find things");

    spawned?.proc.emitAssistant("hello");
    spawned?.proc.close(0);
    const outcome = await handle.wait();
    expect(outcome.text).toBe("hello");
    expect(outcome.usage.turns).toBe(1);
    expect(outcome.usage.input).toBe(10);
    expect(outcome.usage.cost).toBeCloseTo(0.03);
    expect(outcome.model).toBe("test-model");
    expect(handle.status).toBe("completed");
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
    expect(flagIndex).toBeGreaterThan(-1);
    const promptPath = args[flagIndex + 1] as string;
    expect(fs.readFileSync(promptPath, "utf-8")).toBe("You are a scout.");

    procs[0]?.proc.emitAssistant("ok");
    procs[0]?.proc.close(0);
    await handle.wait();
    expect(fs.existsSync(promptPath)).toBe(false);
  });

  test("nonzero exit rejects with SpawnFailure", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "worker", task: "t", cwd: "/tmp" });
    procs[0]?.proc.stderr.emit("data", "something broke");
    procs[0]?.proc.close(2);
    expect(handle.wait()).rejects.toThrow(SpawnFailure);
    await handle.wait().catch((error: SpawnFailure) => {
      expect(error.message).toContain("worker failed");
      expect(error.exitCode).toBe(2);
    });
  });

  test("stopReason error rejects even with exit 0", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    procs[0]?.proc.emitAssistant("partial", {
      stopReason: "error",
      errorMessage: "model exploded",
    });
    procs[0]?.proc.close(0);
    await expect(handle.wait()).rejects.toThrow("model exploded");
  });

  test("abort sends SIGTERM and rejects with SpawnAborted", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    handle.abort();
    expect(procs[0]?.proc.killed).toContain("SIGTERM");
    procs[0]?.proc.close(1, "SIGTERM");
    await expect(handle.wait()).rejects.toThrow(SpawnAborted);
    expect(handle.status).toBe("aborted");
  });

  test("streams progress updates", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const seen: string[] = [];
    const reader = (async () => {
      for await (const update of handle.updates) seen.push(update.text);
    })();
    procs[0]?.proc.emitAssistant("first");
    procs[0]?.proc.emitAssistant("second");
    procs[0]?.proc.close(0);
    await handle.wait();
    await reader;
    expect(seen).toEqual(["first", "second"]);
  });

  test("split JSON lines across chunks still parse", async () => {
    const { engine, procs } = makeEngine();
    const handle = engine.spawn({ agent: "w", task: "t", cwd: "/tmp" });
    const line = `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "chunked" }],
      },
    })}\n`;
    const mid = Math.floor(line.length / 2);
    procs[0]?.proc.stdout.emit("data", line.slice(0, mid));
    procs[0]?.proc.stdout.emit("data", line.slice(mid));
    procs[0]?.proc.close(0);
    const outcome = await handle.wait();
    expect(outcome.text).toBe("chunked");
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
