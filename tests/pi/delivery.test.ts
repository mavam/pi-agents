import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import { GRAPH_RESULT_MESSAGE, RESULT_MESSAGE } from "../../src/pi/messages.js";
import { PiParent } from "../../src/pi/parent.js";
import {
  closeService,
  createFaux,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "../agents/helpers.js";

interface Sent {
  customType: string;
  content: string;
  details?: { delivery?: string };
  options?: { triggerTurn?: boolean };
}

let service: AgentService | undefined;

afterEach(async () => {
  if (service) await closeService(service);
  service = undefined;
});

let nextEntry = 0;

/** A session entry of a posted result message. */
function messageEntry(message: Sent): SessionEntry {
  return {
    type: "custom_message",
    id: `e${++nextEntry}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: message.customType,
    content: message.content,
    display: true,
    details: message.details,
  };
}

/** A session entry of a tool call's stored result. */
function toolResultEntry(
  toolCallId: string,
  options: { deliveries?: string[]; nested?: string[] } = {},
): SessionEntry {
  return {
    type: "message",
    id: `e${++nextEntry}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: options.nested ? "code" : "agent_wait",
      content: [{ type: "text", text: "…" }],
      details: options.deliveries ? { deliveries: options.deliveries } : {},
      ...(options.nested
        ? {
            nestedCalls: {
              calls: options.nested.map((id) => ({
                id,
                name: "agent_wait",
                status: "ok" as const,
              })),
              complete: true,
            },
          }
        : {}),
      isError: false,
      timestamp: Date.now(),
    },
  };
}

/**
 * A Pi parent over a fake session whose state the test controls. Pi saves a
 * posted message unless `saves` is false, and reports it before saving.
 */
function setup(
  state: { idle: boolean; pending: boolean; saves?: boolean },
  entries: SessionEntry[] = [],
) {
  const sent: Sent[] = [];
  let parent: PiParent | undefined;
  const pi = {
    sendMessage: (message: Sent, options?: { triggerTurn?: boolean }) => {
      sent.push({ ...message, ...(options ? { options } : {}) });
      if (state.saves === false) return;
      entries.push(messageEntry(message));
      setTimeout(() => parent?.notify(), 0);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: { getEntries: () => [...entries] },
  } as unknown as ExtensionContext;
  parent = new PiParent(pi);
  parent.setContext(ctx);
  return { sent, parent, entries };
}

/** Long enough for a delivery that would happen to happen. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("delivery to Pi", () => {
  test("posts results once the parent is idle and wakes it", async () => {
    const state = { idle: false, pending: false };
    const { sent, parent } = setup(state);
    const current = await openService({ parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await current.spawn({ task: "b", name: "b", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 2);

    parent.notify();
    await settle();
    expect(sent).toEqual([]);

    state.idle = true;
    parent.notify();
    await until(() => sent.length === 2);
    expect(sent.map((message) => message.customType)).toEqual([
      RESULT_MESSAGE,
      RESULT_MESSAGE,
    ]);
    expect(sent[0]?.content).toBe("Agent a answered:\n\ndone: a");
    // Only the last message starts a parent turn.
    expect(sent.map((message) => message.options?.triggerTurn)).toEqual([
      undefined,
      true,
    ]);
    await until(() => current.pendingDeliveries().length === 0);
    parent.notify();
    await settle();
    expect(sent).toHaveLength(2);
  });

  test("holds results while blocked or while messages are pending", async () => {
    const state = { idle: true, pending: true };
    const { sent, parent } = setup(state);
    let attached = true;
    parent.setBlocked(() => attached);
    const current = await openService({ parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 1);

    parent.notify();
    state.pending = false;
    parent.notify();
    await settle();
    expect(sent).toEqual([]);

    attached = false;
    parent.notify();
    await until(() => sent.length === 1);
  });

  test("posts one message per graph with its end agent's answer", async () => {
    const { sent, parent } = setup({ idle: true, pending: false });
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      name: "pair",
      agents: [
        { name: "a", task: "a", cwd: ".", model: MODEL },
        { name: "merge", task: "merge", cwd: ".", model: MODEL, after: ["a"] },
      ],
    });
    await until(() => sent.length === 1);
    expect(sent.map((message) => message.customType)).toEqual([
      GRAPH_RESULT_MESSAGE,
    ]);
    // Only the end agent's answer reaches the parent, attributed to it.
    expect(sent[0]?.content).toStartWith("Graph pair: merge answered:\n\n");
    expect(sent[0]?.content).toContain("done: merge");
    expect(sent[0]?.options?.triggerTurn).toBe(true);
    await until(() => current.getGraph("pair")?.closed === true);
    parent.notify();
    await settle();
    expect(sent).toHaveLength(1);
  });

  test("a graph without edges reports every agent's answer", async () => {
    const { sent, parent } = setup({ idle: true, pending: false });
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      name: "pair",
      agents: [
        { task: "a", cwd: ".", model: MODEL },
        { task: "b", cwd: ".", model: MODEL },
      ],
    });
    await until(() => sent.length === 1);
    expect(sent[0]?.content).toBe(
      [
        "Graph pair finished: 2 answered.",
        "",
        "## pair-1 (answered)",
        "done: a",
        "",
        "## pair-2 (answered)",
        "done: b",
      ].join("\n"),
    );
  });
});

describe("confirmed delivery to Pi", () => {
  test("a result counts as delivered only once the session holds it", async () => {
    const state = { idle: true, pending: false, saves: false };
    const { sent, parent, entries } = setup(state);
    const current = await openService({ parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => sent.length === 1);
    const delivery = sent[0]?.details?.delivery;
    expect(delivery).toBe(current.pendingDeliveries()[0]?.id);

    // Pi hasn't saved it: it stays pending, and it isn't posted again.
    parent.notify();
    await settle();
    expect(sent).toHaveLength(1);
    expect(current.pendingDeliveries()).toHaveLength(1);
    expect(current.get("a")?.closed).toBe(false);

    entries.push(messageEntry(sent[0] as Sent));
    parent.notify();
    await until(() => current.pendingDeliveries().length === 0);
    expect(current.get("a")?.closed).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test("a restart after Pi saved a result doesn't post it again", async () => {
    const directory = tempDir();
    const first = setup({ idle: true, pending: false, saves: false });
    const before = await openService({
      parent: first.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => first.sent.length === 1);
    // Pi saved the message, and pi-agents crashed before it saw it.
    await closeService(before);
    const entries = [messageEntry(first.sent[0] as Sent)];

    const second = setup({ idle: true, pending: false }, entries);
    const after = await openService({
      parent: second.parent,
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    service = after;
    await until(() => after.get("a")?.closed === true);
    expect(after.pendingDeliveries()).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  test("a restart before Pi saved a result posts it again", async () => {
    const directory = tempDir();
    const first = setup({ idle: true, pending: false, saves: false });
    const before = await openService({
      parent: first.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => first.sent.length === 1);
    await settle();
    // Never acknowledged: the result is still due when the process ends.
    expect(before.pendingDeliveries()).toHaveLength(1);
    await closeService(before);

    const second = setup({ idle: true, pending: false });
    const after = await openService({
      parent: second.parent,
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    service = after;
    await until(() => second.sent.length === 1);
    expect(second.sent[0]?.details?.delivery).toBe(
      first.sent[0]?.details?.delivery,
    );
    await until(() => after.get("a")?.closed === true);
  });

  test("a wait's stored result counts as its delivery", async () => {
    const state = { idle: false, pending: false };
    const { sent, parent, entries } = setup(state);
    const current = await openService({ parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    const outcome = await current.wait(["a"], { call: "toolu_1" });
    expect(outcome.deliveries).toHaveLength(1);
    parent.claim("toolu_1", outcome.deliveries);

    // Until Pi stored the call's result, the result is neither delivered
    // nor posted, even once the parent is idle.
    state.idle = true;
    parent.notify();
    await settle();
    expect(sent).toEqual([]);
    expect(current.get("a")?.queued).toBeUndefined();
    expect(current.get("a")?.closed).toBe(false);

    entries.push(
      toolResultEntry("toolu_1", { deliveries: outcome.deliveries }),
    );
    parent.notify();
    await until(() => current.get("a")?.closed === true);
    expect(sent).toEqual([]);
  });

  test("a script's wait counts once Pi stored the script's result", async () => {
    const { sent, parent, entries } = setup({ idle: true, pending: false });
    const current = await openService({ parent });
    service = current;
    // An earlier result of a call with the same ID doesn't count.
    entries.push(toolResultEntry("toolu_2", { nested: ["toolu_2/1"] }));
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    const outcome = await current.wait(["a"], { call: "toolu_2/1" });
    parent.claim("toolu_2/1", outcome.deliveries);
    parent.notify();
    await settle();
    expect(current.get("a")?.closed).toBe(false);

    // Pi stores no nested results; it records the calls in the caller's.
    entries.push(toolResultEntry("toolu_2", { nested: ["toolu_2/1"] }));
    parent.notify();
    await until(() => current.get("a")?.closed === true);
    expect(sent).toEqual([]);
  });

  test("a restart after Pi stored a wait's result doesn't post it", async () => {
    const directory = tempDir();
    const first = setup({ idle: false, pending: false });
    const before = await openService({
      parent: first.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    const outcome = await before.wait(["a"], { call: "toolu_3" });
    await closeService(before);
    const entries = [
      toolResultEntry("toolu_3", { deliveries: outcome.deliveries }),
    ];

    const second = setup({ idle: true, pending: false }, entries);
    const after = await openService({
      parent: second.parent,
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    service = after;
    await until(() => after.get("a")?.closed === true);
    expect(second.sent).toEqual([]);
  });
});

/**
 * Pi around one posted message, as `sendCustomMessage` treats it: posted
 * while Pi settles its last run, a message waits in Pi's deferred actions,
 * and Pi still looks idle; posted while `takes` is "queue", it lands in the
 * queue of a run, which pi-agents' check rules out but the test forces;
 * otherwise it starts a run that saves it first. The test drives runs.
 */
function fakePi() {
  const state = {
    idle: true,
    settling: false,
    takes: "run" as "run" | "queue",
  };
  const entries: SessionEntry[] = [];
  const sent: Sent[] = [];
  const queued: Sent[] = [];
  const deferred: Sent[] = [];
  const pi = {
    sendMessage: (message: Sent, options?: { triggerTurn?: boolean }) => {
      sent.push({ ...message, ...(options ? { options } : {}) });
      if (state.settling) deferred.push(message);
      else if (state.takes === "queue") {
        state.idle = false;
        queued.push(message);
      } else {
        // The run saves its prompt before anything else.
        state.idle = false;
        entries.push(messageEntry(message));
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    sessionManager: { getEntries: () => [...entries] },
  } as unknown as ExtensionContext;
  const parent = new PiParent(pi);
  parent.setContext(ctx);
  /** The running turn ends: Pi settles, then looks idle. */
  const settle = () => {
    state.idle = true;
    parent.notify();
  };
  return { state, entries, sent, queued, deferred, parent, settle };
}

describe("unsaved deliveries", () => {
  test("an abort that leaves the queue intact posts no duplicate", async () => {
    const pi = fakePi();
    pi.state.takes = "queue";
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => pi.sent.length === 1);
    pi.state.takes = "run";

    // An abort from outside the editor ends the run but keeps the queue.
    pi.settle();
    await settle();
    expect(pi.sent).toHaveLength(1);
    // Until Pi saves it, the result counts as queued.
    expect(current.get("a")?.queued).toBe(true);

    // The next run takes the queued message and saves it.
    pi.state.idle = false;
    for (const message of pi.queued.splice(0))
      pi.entries.push(messageEntry(message));
    pi.settle();
    await until(() => current.get("a")?.closed === true);
    expect(pi.sent).toHaveLength(1);
  });

  test("an abort that clears the queue leaves it queued until a restart", async () => {
    const directory = tempDir();
    const pi = fakePi();
    pi.state.takes = "queue";
    const before = await openService({
      parent: pi.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => pi.sent.length === 1);

    // Esc clears the queue, which Pi doesn't report.
    pi.queued.length = 0;
    pi.settle();
    await settle();
    expect(pi.sent).toHaveLength(1);
    expect(before.get("a")?.queued).toBe(true);
    await closeService(before);

    const next = fakePi();
    const after = await openService({
      parent: next.parent,
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    service = after;
    await until(() => next.sent.length === 1);
    expect(next.sent[0]?.details?.delivery).toBe(pi.sent[0]?.details?.delivery);
    next.settle();
    await until(() => after.get("a")?.closed === true);
  });

  test("a delivery the triggered turn saved is never posted twice", async () => {
    const pi = fakePi();
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => pi.sent.length === 1);
    pi.settle();
    await until(() => current.get("a")?.closed === true);
    pi.settle();
    await settle();
    expect(pi.sent).toHaveLength(1);
  });

  test("a delivery deferred while Pi settles is posted once", async () => {
    const pi = fakePi();
    // Pi settles its last run; a user's prompt waits in its deferred actions.
    pi.state.settling = true;
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => pi.sent.length === 1);
    expect(pi.deferred).toHaveLength(1);
    // Pi looks idle with the message neither queued nor saved, even after
    // this settle and the user's turn, which runs first and settles too.
    pi.settle();
    await settle();
    pi.state.settling = false;
    pi.state.idle = false;
    pi.settle();
    await settle();
    expect(pi.sent).toHaveLength(1);
    expect(current.get("a")?.queued).toBe(true);

    // Then Pi runs the deferred message, which it saves first.
    pi.state.idle = false;
    for (const message of pi.deferred) pi.entries.push(messageEntry(message));
    pi.settle();
    await until(() => current.get("a")?.closed === true);
    expect(pi.sent).toHaveLength(1);
  });
});

type Handler = (event: { type: string }, ctx: unknown) => unknown;

/**
 * A Pi whose events the test emits to the handlers `listen()` registers. A
 * posted message starts a turn, which saves it first.
 */
function eventedPi(
  state: { idle: boolean; pending: boolean },
  recheckMs: number,
) {
  const handlers = new Map<string, Handler[]>();
  const entries: SessionEntry[] = [];
  const sent: Sent[] = [];
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: { getEntries: () => [...entries] },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent, options?: { triggerTurn?: boolean }) => {
      sent.push({ ...message, ...(options ? { options } : {}) });
      state.idle = false;
      entries.push(messageEntry(message));
    },
  } as unknown as ExtensionAPI;
  const parent = new PiParent(pi, { recheckMs });
  parent.setContext(ctx);
  parent.listen();
  const emit = async (type: string) => {
    for (const handler of handlers.get(type) ?? [])
      await handler({ type }, ctx);
  };
  return { state, sent, parent, emit };
}

/** No recheck within a test: only events try delivery again. */
const NEVER = 60_000;

describe("delivery after a busy parent", () => {
  test("a result that arrives during a parent turn posts once it settled", async () => {
    const pi = eventedPi({ idle: false, pending: false }, NEVER);
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 1);

    // The turn ends, but another extension's agent_end handler keeps Pi
    // busy well past a macrotask, and nothing changes in the service.
    await pi.emit("message_end");
    await pi.emit("agent_end");
    await settle();
    expect(pi.sent).toEqual([]);

    // Pi turns idle only when it settles.
    pi.state.idle = true;
    await pi.emit("agent_settled");
    await until(() => pi.sent.length === 1);

    // The turn the result started saves it first, then runs and settles;
    // nothing posts again.
    await pi.emit("message_end");
    await until(() => current.get("a")?.closed === true);
    pi.state.idle = true;
    await pi.emit("agent_settled");
    await settle();
    expect(pi.sent).toHaveLength(1);
  });

  test("a result held back by messages left queued posts once they're gone", async () => {
    const pi = eventedPi({ idle: false, pending: false }, 20);
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 1);

    // An abort ends the turn but leaves the user's queued messages.
    pi.state.idle = true;
    pi.state.pending = true;
    await pi.emit("agent_settled");
    await settle();
    expect(pi.sent).toEqual([]);

    // Something clears them, and no event says so.
    pi.state.pending = false;
    await until(() => pi.sent.length === 1);
    await pi.emit("message_end");
    await until(() => current.get("a")?.closed === true);
    await settle();
    expect(pi.sent).toHaveLength(1);
  });

  test("a compaction outside a turn ends with an event", async () => {
    const pi = eventedPi({ idle: false, pending: false }, NEVER);
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 1);
    await settle();
    expect(pi.sent).toEqual([]);
    pi.state.idle = true;
    await pi.emit("session_compact");
    await until(() => pi.sent.length === 1);
  });

  test("a cancelled branch summary, which emits nothing, delays delivery only briefly", async () => {
    const pi = eventedPi({ idle: false, pending: false }, 20);
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => current.pendingDeliveries().length === 1);
    await settle();
    expect(pi.sent).toEqual([]);
    pi.state.idle = true;
    await until(() => pi.sent.length === 1);
  });
});
