import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SpawnEngine } from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import type { RunEvent } from "../../src/run/events.js";
import {
  createPersister,
  extractRunEvents,
  RunEventCache,
} from "../../src/run/persist.js";
import { RunManager } from "../../src/run/runs.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import { createWorkflowTool } from "../../src/triggers/tool.js";
import { NotificationManager } from "../../src/ui/notify.js";
import { RunWidget } from "../../src/ui/widget.js";

let projectDir: string;
let sessionFile: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-persist-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "agents", "echo.md"),
    "---\nname: echo\ndescription: echoes\n---\nEcho.\n",
  );
  sessionFile = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(sessionFile, "");
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function* emptyUpdates(): AsyncGenerator<never> {
  // no streamed updates
}

function readSessionEntries(): SessionEntry[] {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry);
}

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RunEventCache", () => {
  const event = (n: number): RunEvent => ({
    type: "loop_iteration",
    at: n,
    runId: "r",
    path: "$",
    instance: "$",
    iteration: n,
  });

  test("appends JSONL entries with a linked parentId chain", () => {
    const cache = new RunEventCache();
    const origin = { parentId: "leaf-0" as string | null, sessionFile };
    expect(cache.appendToOrigin(origin, event(0))).toBe(true);
    expect(cache.appendToOrigin(origin, event(1))).toBe(true);
    const entries = readSessionEntries() as Array<{
      id: string;
      parentId: string | null;
      customType: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.parentId).toBe("leaf-0");
    expect(entries[1]?.parentId).toBe(entries[0]?.id);
    expect(entries[0]?.customType).toBe("pi-agents:run-event:v3");
  });

  test("returns false without a session file", () => {
    const cache = new RunEventCache();
    expect(cache.appendToOrigin({ parentId: null }, event(0))).toBe(false);
  });

  test("mergeEntries adds cached entries missing from disk state", () => {
    const cache = new RunEventCache();
    const origin = { parentId: null, sessionFile };
    cache.appendToOrigin(origin, event(0));
    const merged = cache.mergeEntries(sessionFile, []);
    expect(merged).toHaveLength(1);
    const noDupes = cache.mergeEntries(sessionFile, merged);
    expect(noDupes).toHaveLength(1);
  });

  test("createPersister falls back to pi.appendEntry", () => {
    const appended: unknown[] = [];
    const pi = {
      appendEntry: (_type: string, data: unknown) => appended.push(data),
    } as unknown as ExtensionAPI;
    const persist = createPersister(pi, new RunEventCache(), {
      parentId: null,
    });
    persist(event(0));
    expect(appended).toHaveLength(1);
  });
});

describe("background tool runs", () => {
  test("returns immediately, persists to the origin file, notifies when idle, and replays", async () => {
    const gate = deferred<string>();
    const engine: SpawnEngine = {
      spawn: () => ({
        status: "running",
        updates: emptyUpdates(),
        wait: async () => ({
          text: await gate.promise,
          exitCode: 0,
          usage: emptyUsage(),
        }),
        abort: () => {},
      }),
    };
    const sent: Array<{ customType: string; content: unknown }> = [];
    const pi = {
      sendMessage: (message: { customType: string; content: unknown }) =>
        sent.push(message),
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    // Mirror the index.ts wiring: run events feed the notification manager.
    let notifications!: NotificationManager;
    const manager = new RunManager({
      engine,
      onEvent: (event) => notifications.handleRunEvent(event),
    });
    notifications = new NotificationManager(pi, manager);
    const widget = new RunWidget(manager);
    const deps: TriggerDeps = {
      pi,
      manager,
      cache: new RunEventCache(),
      notifications,
      widget,
    };
    const widgetLines: Array<string[] | undefined> = [];
    const ctx = {
      cwd: projectDir,
      hasUI: true,
      isIdle: () => true,
      sessionManager: {
        getLeafId: () => null,
        getSessionFile: () => sessionFile,
      },
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) =>
          widgetLines.push(lines),
      },
    } as unknown as ExtensionContext;

    const manager2 = new RunManager({ engine });
    void manager2;
    const tool = createWorkflowTool(deps);
    notifications.setContext(ctx);
    const result = await tool.execute(
      "t1",
      {
        flow: { kind: "agent", name: "echo", task: "hi" },
        scope: "project",
        label: "bg-test",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.terminate).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("background");
    const runId = result.details.runId;
    expect(manager.isLive(runId)).toBe(true);
    expect(manager.state.runs.get(runId)?.backgrounded).toBe(true);

    gate.resolve("all done");
    await until(() => manager.state.runs.get(runId)?.status === "completed");

    // Final notification delivered (idle + same session file).
    await until(() =>
      sent.some((message) => message.customType === "pi-agents:notification"),
    );
    const finalText = sent
      .filter((m) => m.customType === "pi-agents:notification")
      .map((m) => String(m.content))
      .join("\n");
    expect(finalText).toContain("completed");

    // Widget rendered while running.
    expect(widgetLines.length).toBeGreaterThan(0);

    // Events landed in the origin session file and replay into fresh state.
    const events = extractRunEvents(readSessionEntries());
    expect(events.some((e) => e.type === "run_created")).toBe(true);
    expect(events.some((e) => e.type === "run_backgrounded")).toBe(true);
    expect(events.some((e) => e.type === "run_completed")).toBe(true);

    const fresh = new RunManager({ engine });
    fresh.absorbHistory(events);
    expect(fresh.state.runs.get(runId)?.status).toBe("completed");
    expect(fresh.state.runs.get(runId)?.value).toBe("all done");
  });

  test("absorbHistory marks unresumable running runs as stopped", async () => {
    const engine: SpawnEngine = {
      spawn: () => ({
        status: "completed",
        updates: emptyUpdates(),
        wait: async () => ({ text: "ok", exitCode: 0, usage: emptyUsage() }),
        abort: () => {},
      }),
    };
    const manager = new RunManager({ engine });
    const events: RunEvent[] = [];
    const { done } = manager.start({
      flow: { kind: "agent", name: "echo", task: "t" },
      cwd: projectDir,
      scope: "project",
      source: { kind: "tool" },
      onEvent: (event) => events.push(event),
    });
    await done;
    // Replay only a prefix (as if pi died mid-run).
    const partial = events.filter((e) => e.type !== "run_completed");
    const fresh = new RunManager({ engine });
    fresh.absorbHistory(partial);
    const run = [...fresh.state.runs.values()][0];
    expect(run?.status).toBe("stopped");
    expect(run?.error).toContain("restarted");
  });
});
