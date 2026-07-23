import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type ListRpcData,
  PROTOCOL_VERSION,
  RPC_REPLY_PREFIX,
  RPC_REQUEST_CHANNEL,
  type RpcReply,
  RUN_EVENT_CHANNEL,
  type StartRpcData,
} from "../../src/api.js";
import type { SpawnEngine, SpawnSpec } from "../../src/engine/types.js";
import { emptyUsage, SpawnAborted } from "../../src/engine/types.js";
import { createRunEventPublisher } from "../../src/run/publish.js";
import { RunManager } from "../../src/run/runs.js";
import { RpcManager } from "../../src/triggers/rpc.js";
import type { TriggerDeps } from "../../src/triggers/start.js";
import { NotificationManager } from "../../src/ui/notify.js";
import { RunWidget } from "../../src/ui/widget.js";

class TestBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }

  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])])
      handler(data);
  }
}

async function* emptyUpdates(): AsyncGenerator<never> {}

function immediateEngine(specs: SpawnSpec[]): SpawnEngine {
  return {
    spawn(spec) {
      specs.push(spec);
      return {
        status: "completed",
        updates: emptyUpdates(),
        wait: async () => ({ text: "ok", exitCode: 0, usage: emptyUsage() }),
        abort: () => {},
      };
    },
  };
}

function blockingEngine(specs: SpawnSpec[]): SpawnEngine {
  return {
    spawn(spec) {
      specs.push(spec);
      let reject!: (error: Error) => void;
      const result = new Promise<never>((_resolve, rejectResult) => {
        reject = rejectResult;
      });
      return {
        status: "running",
        updates: emptyUpdates(),
        wait: () => result,
        abort: () => reject(new SpawnAborted(spec.agent)),
      };
    },
  };
}

let projectDir: string;

function writeWorkflow(name: string): void {
  const directory = path.join(projectDir, ".pi", "workflows");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${name}.yaml`),
    `name: ${name}\ndescription: test workflow\nparams:\n  - name: target\n    required: true\nflow: { kind: agent, task: "hello {params.target}" }\n`,
  );
}

interface HarnessOptions {
  trusted?: boolean;
  active?: boolean;
  blocking?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const bus = new TestBus();
  const sent: unknown[] = [];
  const specs: SpawnSpec[] = [];
  const pi = {
    events: bus,
    sendMessage: (message: unknown) => sent.push(message),
  } as unknown as ExtensionAPI;
  let notifications!: NotificationManager;
  const manager = new RunManager({
    engine: options.blocking ? blockingEngine(specs) : immediateEngine(specs),
    onEvent: (event) => notifications.handleRunEvent(event),
    publish: createRunEventPublisher(pi),
  });
  notifications = new NotificationManager(pi, manager);
  const deps: TriggerDeps = {
    pi,
    manager,
    notifications,
    widget: new RunWidget(manager),
  };
  const rpc = new RpcManager(pi, deps, "0.3.0");
  rpc.install();
  const ctx = {
    cwd: projectDir,
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  if (options.active ?? true) rpc.setContext(ctx);
  return { bus, manager, pi, rpc, sent, specs };
}

function call<T>(
  bus: TestBus,
  request: Record<string, unknown>,
): Promise<RpcReply<T>> {
  const id = request.id as string;
  return new Promise((resolve) => {
    const unsubscribe = bus.on(`${RPC_REPLY_PREFIX}${id}`, (reply) => {
      unsubscribe();
      resolve(reply as RpcReply<T>);
    });
    bus.emit(RPC_REQUEST_CHANNEL, request);
  });
}

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-rpc-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("RpcManager", () => {
  test("pings without an active session on the derived reply channel", async () => {
    const { bus } = harness({ active: false });
    let injected = false;
    bus.on("unrelated-channel", () => {
      injected = true;
    });
    const reply = await call<{ protocol: 1; version: string }>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "ping-1",
      op: "ping",
      reply: "unrelated-channel",
    });
    expect(reply).toEqual({
      protocol: PROTOCOL_VERSION,
      id: "ping-1",
      success: true,
      data: { protocol: PROTOCOL_VERSION, version: "0.3.0" },
    });
    expect(injected).toBe(false);
  });

  test("rejects start without an active session", async () => {
    const { bus } = harness({ active: false });
    const reply = await call(bus, {
      protocol: PROTOCOL_VERSION,
      id: "start-inactive",
      op: "start",
      params: { flow: { kind: "agent", task: "hello" } },
    });
    expect(reply.success).toBe(false);
    if (!reply.success) expect(reply.error).toBe("No active session");
  });

  test("starts a saved workflow, publishes events, and lists attribution", async () => {
    writeWorkflow("rpc-greet");
    const { bus, manager, specs } = harness();
    const eventTypes: string[] = [];
    bus.on(RUN_EVENT_CHANNEL, (raw) => {
      const envelope = raw as { event: { type: string } };
      eventTypes.push(envelope.event.type);
    });

    const reply = await call<StartRpcData>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "start-saved",
      caller: "test-dashboard",
      op: "start",
      params: { workflow: "rpc-greet", params: { target: "world" } },
    });
    expect(reply.success).toBe(true);
    if (!reply.success) return;
    await until(
      () => manager.state.runs.get(reply.data.runId)?.status === "completed",
    );

    const run = manager.state.runs.get(reply.data.runId);
    expect(run?.header.source).toEqual({
      kind: "rpc",
      workflow: "rpc-greet",
      caller: "test-dashboard",
    });
    expect(run?.backgrounded).toBe(true);
    expect(specs[0]?.task).toBe("hello world");
    expect(eventTypes).toContain("run_created");
    expect(eventTypes).toContain("run_backgrounded");
    expect(eventTypes).toContain("run_completed");

    const listReply = await call<ListRpcData>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "list-1",
      op: "list",
    });
    expect(listReply.success).toBe(true);
    if (listReply.success) {
      expect(listReply.data.runs[0]).toEqual({
        runId: reply.data.runId,
        label: "rpc-greet",
        status: "completed",
        source: {
          kind: "rpc",
          workflow: "rpc-greet",
          caller: "test-dashboard",
        },
      });
    }
  });

  test("stops an exact live run", async () => {
    const { bus, manager } = harness({ blocking: true });
    const started = await call<StartRpcData>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "start-slow",
      op: "start",
      params: { flow: { kind: "agent", task: "wait" } },
    });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const stopped = await call<{ runId: string }>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "stop-slow",
      op: "stop",
      params: { runId: started.data.runId },
    });
    expect(stopped).toEqual({
      protocol: PROTOCOL_VERSION,
      id: "stop-slow",
      success: true,
      data: { runId: started.data.runId },
    });
    await until(
      () => manager.state.runs.get(started.data.runId)?.status === "stopped",
    );

    const again = await call(bus, {
      protocol: PROTOCOL_VERSION,
      id: "stop-again",
      op: "stop",
      params: { runId: started.data.runId },
    });
    expect(again.success).toBe(false);
  });

  test("validates protocol, operations, start shape, cwd, and trust", async () => {
    writeWorkflow("project-only-rpc");
    const { bus } = harness({ trusted: false });
    const requests = [
      {
        protocol: 99,
        id: "bad-protocol",
        op: "ping",
      },
      {
        protocol: PROTOCOL_VERSION,
        id: "bad-op",
        op: "explode",
      },
      {
        protocol: PROTOCOL_VERSION,
        id: "bad-shape",
        op: "start",
        params: {
          flow: { kind: "agent", task: "hello" },
          workflow: "project-only-rpc",
        },
      },
      {
        protocol: PROTOCOL_VERSION,
        id: "bad-cwd",
        op: "start",
        params: { flow: { kind: "agent", task: "hello" }, cwd: "relative" },
      },
      {
        protocol: PROTOCOL_VERSION,
        id: "untrusted-workflow",
        op: "start",
        params: { workflow: "project-only-rpc", params: { target: "x" } },
      },
    ];
    for (const request of requests) {
      const reply = await call(bus, request);
      expect(reply.success).toBe(false);
    }
  });

  test("drops requests without a safe correlation id and unsubscribes on dispose", async () => {
    const { bus, rpc } = harness();
    let unsafeReply = false;
    let disposedReply = false;
    bus.on(`${RPC_REPLY_PREFIX}unsafe:id`, () => {
      unsafeReply = true;
    });
    bus.emit(RPC_REQUEST_CHANNEL, {
      protocol: PROTOCOL_VERSION,
      id: "unsafe:id",
      op: "ping",
    });
    rpc.dispose();
    bus.on(`${RPC_REPLY_PREFIX}after-dispose`, () => {
      disposedReply = true;
    });
    bus.emit(RPC_REQUEST_CHANNEL, {
      protocol: PROTOCOL_VERSION,
      id: "after-dispose",
      op: "ping",
    });
    await Promise.resolve();
    expect(unsafeReply).toBe(false);
    expect(disposedReply).toBe(false);
  });

  test("supports a guarded reentrant start from a run-event subscriber", async () => {
    const { bus, manager } = harness();
    let nested = false;
    let nestedRunId: string | undefined;
    bus.on(RUN_EVENT_CHANNEL, (raw) => {
      const envelope = raw as { event: { type: string } };
      if (nested || envelope.event.type !== "run_completed") return;
      nested = true;
      const id = "nested-start";
      bus.on(`${RPC_REPLY_PREFIX}${id}`, (reply) => {
        const typed = reply as RpcReply<StartRpcData>;
        if (typed.success) nestedRunId = typed.data.runId;
      });
      bus.emit(RPC_REQUEST_CHANNEL, {
        protocol: PROTOCOL_VERSION,
        id,
        op: "start",
        params: { flow: { kind: "agent", task: "nested" } },
      });
    });

    const first = await call<StartRpcData>(bus, {
      protocol: PROTOCOL_VERSION,
      id: "first-start",
      op: "start",
      params: { flow: { kind: "agent", task: "first" } },
    });
    expect(first.success).toBe(true);
    await until(
      () =>
        nestedRunId !== undefined &&
        manager.state.runs.get(nestedRunId)?.status === "completed",
    );
    expect(manager.state.runs.size).toBe(2);
  });
});
