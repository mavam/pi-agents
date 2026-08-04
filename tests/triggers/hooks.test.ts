import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnEngine, SpawnSpec } from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import { RunManager } from "../../src/run/runs.js";
import { compactEventJson, HookManager } from "../../src/triggers/hooks.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import { NotificationManager } from "../../src/ui/notify.js";
import { RunWidget } from "../../src/ui/widget.js";

let projectDir: string;

function writeFile(relative: string, content: string): void {
  const filePath = path.join(projectDir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function* emptyUpdates(): AsyncGenerator<never> {
  // no streamed updates
}

interface HarnessOptions {
  debounceMs?: number;
  /** Simulated project-trust decision (ctx.isProjectTrusted()). */
  trusted?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const { debounceMs, trusted = true } = options;
  const specs: SpawnSpec[] = [];
  const engine: SpawnEngine = {
    spawn(spec) {
      specs.push(spec);
      return {
        status: "completed",
        updates: emptyUpdates(),
        wait: async () => ({ value: "ok", exitCode: 0, usage: emptyUsage() }),
        abort: () => {},
      };
    },
  };
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => void>
  >();
  const sent: string[] = [];
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    sendMessage: (message: { content: unknown }) =>
      sent.push(String(message.content)),
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  let notifications!: NotificationManager;
  const manager = new RunManager({
    engine,
    onEvent: (event) => notifications.handleRunEvent(event),
  });
  notifications = new NotificationManager(pi, manager);
  const deps: TriggerDeps = {
    pi,
    manager,
    notifications,
    widget: new RunWidget(manager),
  };
  const hooks = new HookManager(pi, deps);
  hooks.install();

  writeFile(
    ".pi/workflows/on-turn.yaml",
    `name: on-turn\ndescription: reacts to turn end\non: [turn_end]\n${debounceMs !== undefined ? `debounce: ${debounceMs}\n` : ""}flow: { kind: agent, name: echo, task: "react to {params.event}" }\n`,
  );
  hooks.refresh(projectDir, trusted);

  const ctx = {
    cwd: projectDir,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getLeafId: () => null,
      getSessionFile: () => undefined,
    },
    ui: { setWidget: () => {} },
  } as unknown as ExtensionContext;

  const emit = (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };

  return { specs, hooks, emit, manager, sent };
}

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-hooks-"));
  writeFile(
    ".pi/agents/echo.md",
    "---\nname: echo\ndescription: echoes\n---\nEcho.\n",
  );
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("event hooks", () => {
  test("a hooked event starts a background run with {params.event} bound", async () => {
    const { specs, emit, manager } = harness();
    emit("turn_end", { type: "turn_end", detail: "something happened" });
    await until(() => specs.length === 1);
    expect(specs[0]?.task).toContain("react to ");
    expect(specs[0]?.task).toContain("something happened");
    await until(() =>
      [...manager.state.runs.values()].some(
        (run) => run.status === "completed",
      ),
    );
    const run = [...manager.state.runs.values()][0];
    expect(run?.header.source).toMatchObject({
      kind: "hook",
      workflow: "on-turn",
      event: "turn_end",
    });
    expect(run?.backgrounded).toBe(true);
  });

  test("unhooked events do nothing", async () => {
    const { specs, emit } = harness();
    emit("agent_end", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(specs).toHaveLength(0);
  });

  test("debounce coalesces bursts into one run (trailing edge)", async () => {
    const { specs, emit, hooks } = harness({ debounceMs: 30 });
    emit("turn_end", { n: 1 });
    emit("turn_end", { n: 2 });
    emit("turn_end", { n: 3 });
    expect(hooks.pendingDebounces()).toEqual(["on-turn"]);
    await until(() => specs.length > 0, 3000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(specs).toHaveLength(1);
    // Trailing edge: the last event wins.
    expect(specs[0]?.task).toContain('"n":3');
  });

  test("a hook run completing does not retrigger further hooks", async () => {
    const { specs, emit, manager } = harness();
    emit("turn_end", { n: 1 });
    await until(() => specs.length === 1);
    await until(() =>
      [...manager.state.runs.values()].every((run) => run.status !== "running"),
    );
    // Completion + notification delivery must not spawn anything new.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(specs).toHaveLength(1);
    expect(manager.state.runs.size).toBe(1);
  });

  test("untrusted projects contribute no hook workflows", async () => {
    const { specs, emit } = harness({ trusted: false });
    emit("turn_end", { n: 1 });
    emit("session_start", {});
    emit("turn_end", { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(specs).toHaveLength(0);
  });

  test("trusting the project enables its hooks without extra prompts", async () => {
    const { specs, emit } = harness({ trusted: true });
    emit("turn_end", { n: 1 });
    await until(() => specs.length === 1);
  });

  test("session_start refreshes before filtering, so its own hooks fire", async () => {
    const { specs, emit, hooks } = harness();
    writeFile(
      ".pi/workflows/on-start.yaml",
      'name: on-start\ndescription: d\non: [session_start]\nflow: { kind: agent, name: echo, task: "startup {params.event}" }\n',
    );
    // Simulate a fresh factory: no refresh has happened yet.
    hooks.refresh("/nonexistent");
    emit("session_start", {});
    await until(() => specs.some((spec) => spec.task.startsWith("startup")));
  });

  test("dispose clears pending debounce timers and stops firing", async () => {
    const { specs, emit, hooks } = harness({ debounceMs: 30 });
    emit("turn_end", { n: 1 });
    expect(hooks.pendingDebounces()).toEqual(["on-turn"]);
    hooks.dispose();
    expect(hooks.pendingDebounces()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(specs).toHaveLength(0);
    emit("turn_end", { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(specs).toHaveLength(0);
  });

  test("catalog rejects unknown event names in on:", () => {
    writeFile(
      ".pi/workflows/bad-hook.yaml",
      "name: bad-hook\ndescription: d\non: [not_an_event]\nflow: { kind: agent, name: echo, task: t }\n",
    );
    const { hooks } = harness();
    void hooks;
    // Re-discover through the catalog directly:
    const { discoverWorkflows } = require("../../src/catalog/workflows.js") as {
      discoverWorkflows: typeof import("../../src/catalog/workflows.js")["discoverWorkflows"];
    };
    const { diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics.map((d) => d.message).join("\n")).toContain(
      "Unknown event(s) in 'on': not_an_event",
    );
  });
});

describe("compactEventJson", () => {
  test("drops heavy keys and truncates long strings", () => {
    const json = compactEventJson({
      type: "before_agent_start",
      systemPrompt: "x".repeat(10_000),
      prompt: "y".repeat(1_000),
    });
    expect(json).not.toContain("x".repeat(600));
    expect(json).not.toContain("systemPrompt");
    expect(json).toContain("…");
    expect(json.length).toBeLessThanOrEqual(4001);
  });

  test("survives circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(compactEventJson(circular)).toBe("{}");
  });
});
