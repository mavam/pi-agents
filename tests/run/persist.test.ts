import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnEngine } from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import type { RunEvent } from "../../src/run/events.js";
import {
  appendRunEvent,
  createPersister,
  readRunEvents,
  sidecarPath,
} from "../../src/run/persist.js";
import { RunManager } from "../../src/run/runs.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import { createWorkflowCreateTool as createWorkflowTool } from "../../src/triggers/tool.js";
import { NotificationManager } from "../../src/ui/notify.js";
import { RunPanel } from "../../src/ui/panel.js";

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
  fs.writeFileSync(sessionFile, '{"type":"session","id":"s1"}\n');
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

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("sidecar persistence", () => {
  const event = (n: number): RunEvent => ({
    type: "loop_iteration",
    at: n,
    runId: "r",
    path: "$",
    instance: "$",
    iteration: n,
  });

  test("events go to the sidecar, never into the session file", () => {
    const origin = { sessionFile };
    expect(appendRunEvent(origin, event(0))).toBe(true);
    expect(appendRunEvent(origin, event(1))).toBe(true);
    // The session file is untouched — pi's leaf (last line) is preserved.
    expect(fs.readFileSync(sessionFile, "utf-8")).toBe(
      '{"type":"session","id":"s1"}\n',
    );
    const events = readRunEvents(sessionFile);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "loop_iteration", iteration: 1 });
  });

  test("large values round-trip uncropped", () => {
    const big = "y".repeat(100_000);
    const completed: RunEvent = {
      type: "node_completed",
      at: 1,
      runId: "r",
      instance: "$",
      value: big,
    };
    expect(appendRunEvent({ sessionFile }, completed)).toBe(true);
    const events = readRunEvents(sessionFile);
    expect(events[0]).toMatchObject({ type: "node_completed", value: big });
  });

  test("no session file means no persistence", () => {
    expect(appendRunEvent({}, event(0))).toBe(false);
    expect(readRunEvents(undefined)).toEqual([]);
  });

  test("missing sidecar reads as empty; corrupt lines are skipped", () => {
    expect(readRunEvents(sessionFile)).toEqual([]);
    fs.writeFileSync(
      sidecarPath(sessionFile),
      `${JSON.stringify(event(0))}\nnot json\n${JSON.stringify(event(1))}\n`,
    );
    expect(readRunEvents(sessionFile)).toHaveLength(2);
  });

  test("createPersister never throws", () => {
    const persist = createPersister({ sessionFile: "/nonexistent/dir/x" });
    expect(() => persist(event(0))).not.toThrow();
  });
});

describe("background tool runs", () => {
  test("returns immediately, persists to the sidecar, notifies when idle, and replays", async () => {
    const gate = deferred<string>();
    const engine: SpawnEngine = {
      spawn: () => ({
        status: "running",
        updates: emptyUpdates(),
        wait: async () => ({
          value: await gate.promise,
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
    const widget = new RunPanel(manager);
    const deps: TriggerDeps = { pi, manager, notifications, widget };
    const widgetLines: Array<string[] | undefined> = [];
    const ctx = {
      cwd: projectDir,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      model: { provider: "test", id: "session-model" },
      sessionManager: {
        getLeafId: () => null,
        getSessionFile: () => sessionFile,
      },
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) =>
          widgetLines.push(lines),
      },
    } as unknown as ExtensionContext;

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

    // The session file itself was never touched.
    expect(fs.readFileSync(sessionFile, "utf-8")).toBe(
      '{"type":"session","id":"s1"}\n',
    );

    // Events landed in the sidecar and replay into fresh state.
    const events = readRunEvents(sessionFile);
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
        wait: async () => ({ value: "ok", exitCode: 0, usage: emptyUsage() }),
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
