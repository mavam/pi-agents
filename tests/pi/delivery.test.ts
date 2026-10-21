import { afterEach, describe, expect, test } from "bun:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import { GRAPH_RESULT_MESSAGE } from "../../src/pi/messages.js";
import { PiParent } from "../../src/pi/parent.js";
import {
  closeService,
  createFaux,
  createGatedFaux,
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

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Pi's session manager, in memory. The test appends what Pi would: saved
 * result messages, the parent's tool calls, and their stored results.
 */
function piSession(manager = SessionManager.inMemory(process.cwd())) {
  return {
    manager,
    save: (message: Sent) =>
      manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        true,
        message.details,
      ),
    /** The parent's turn issues a tool call. */
    issue: (id: string, name = "agent_wait") =>
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: USAGE,
        stopReason: "toolUse",
        timestamp: Date.now(),
      }),
    /** Pi stores a call's result, which records its nested calls. */
    store: (
      toolCallId: string,
      options: {
        deliveries?: string[];
        nested?: string[];
        isError?: boolean;
      } = {},
    ) =>
      manager.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName: options.nested ? "codemode" : "agent_wait",
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
        isError: options.isError ?? false,
        timestamp: Date.now(),
      }),
  };
}

type Handler = (event: { type: string }, ctx: unknown) => unknown;

/**
 * A Pi parent over a session whose state the test controls. Pi saves a
 * posted message unless `saves` is false; the test emits Pi's events.
 */
function setup(
  state: { idle: boolean; pending?: boolean; saves?: boolean },
  options: { session?: ReturnType<typeof piSession>; recheckMs?: number } = {},
) {
  const session = options.session ?? piSession();
  const sent: Sent[] = [];
  const handlers = new Map<string, Handler[]>();
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending === true,
    sessionManager: session.manager,
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message: Sent, options?: { triggerTurn?: boolean }) => {
      sent.push({ ...message, ...(options ? { options } : {}) });
      if (state.saves === false) return;
      session.save(message);
      setTimeout(() => parent.notify(), 0);
    },
  } as unknown as ExtensionAPI;
  const parent = new PiParent(pi, { recheckMs: options.recheckMs ?? 60_000 });
  parent.setContext(ctx);
  parent.listen();
  const emit = async (type: string) => {
    for (const handler of handlers.get(type) ?? [])
      await handler({ type }, ctx);
  };
  return { sent, parent, session, emit };
}

/** Long enough for a delivery that would happen to happen. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("delivery to Pi", () => {
  test("posts results once Pi is idle and no agent is attached", async () => {
    const state = { idle: false };
    const { sent, parent } = setup(state);
    let attached = true;
    parent.setBlocked(() => attached);
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await current.spawnGraph({
      agents: [{ job: "b", name: "b", cwd: ".", model: MODEL }],
    });
    await until(() => current.pendingDeliveries().length === 2);

    state.idle = true;
    parent.notify();
    await settle();
    expect(sent).toEqual([]);

    attached = false;
    parent.notify();
    await until(() => sent.length === 2);
    expect(sent.map((message) => message.customType)).toEqual([
      GRAPH_RESULT_MESSAGE,
      GRAPH_RESULT_MESSAGE,
    ]);
    expect(sent[0]?.content).toBe("a answered:\n\ndone: a");
    // Only the last message starts a parent turn.
    expect(sent.map((message) => message.options?.triggerTurn)).toEqual([
      undefined,
      true,
    ]);
    await until(() => current.get("b")?.closed === true);
    parent.notify();
    await settle();
    expect(sent).toHaveLength(2);
  });

  test("delivers the original failure detail after a later turn answers", async () => {
    const state = { idle: false };
    const { sent, parent } = setup(state);
    const current = await openService({
      parent,
      models: createGatedFaux().models,
    });
    service = current;
    await current.spawnGraph({
      agents: [
        {
          job: "fail first",
          name: "a",
          cwd: ".",
          model: MODEL,
        },
      ],
    });
    await until(() => current.pendingDeliveries().length === 1);
    await current.send("a", "second", "steer");
    await until(() => current.get("a")?.result?.text === "done: second");

    state.idle = true;
    parent.notify();
    await until(() => sent.length === 2);
    expect(sent.map((message) => message.content)).toEqual([
      "a failed: cannot fail first.",
      "Agent a answered:\n\ndone: second",
    ]);
  });

  test("posts one message per graph with its end agent's answer", async () => {
    const { sent, parent } = setup({ idle: true });
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      name: "pair",
      agents: [
        { name: "a", job: "a", cwd: ".", model: MODEL },
        { name: "merge", job: "merge", cwd: ".", model: MODEL, after: ["a"] },
      ],
    });
    await until(() => sent.length === 1);
    expect(sent[0]?.customType).toBe(GRAPH_RESULT_MESSAGE);
    expect(sent[0]?.content).toStartWith("Graph pair: merge answered:\n\n");
    await until(() => current.getGraph("pair")?.closed === true);
  });

  test("a result that arrives while Pi works posts once it settled", async () => {
    const state = { idle: false };
    const pi = setup(state);
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await until(() => current.pendingDeliveries().length === 1);
    await settle();
    expect(pi.sent).toEqual([]);

    // Pi turns idle only when it settles, which the core doesn't see.
    state.idle = true;
    await pi.emit("agent_settled");
    await until(() => pi.sent.length === 1);
  });

  test("a result held back without an event posts on a recheck", async () => {
    // Messages an abort left queued can be cleared without an event.
    const state = { idle: true, pending: true };
    const pi = setup(state, { recheckMs: 20 });
    const current = await openService({ parent: pi.parent });
    service = current;
    await current.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await until(() => current.pendingDeliveries().length === 1);
    await settle();
    expect(pi.sent).toEqual([]);

    state.pending = false;
    await until(() => pi.sent.length === 1);
  });
});

describe("confirmed delivery to Pi", () => {
  test("a result counts as delivered only once the session holds it", async () => {
    const { sent, parent, session } = setup({ idle: true, saves: false });
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await until(() => sent.length === 1);
    expect(sent[0]?.details?.delivery).toBe(current.pendingDeliveries()[0]?.id);

    // Pi hasn't saved it: it stays pending, and it isn't posted again.
    parent.notify();
    await settle();
    expect(sent).toHaveLength(1);
    expect(current.get("a")?.closed).toBe(false);

    session.save(sent[0] as Sent);
    parent.notify();
    await until(() => current.get("a")?.closed === true);
    expect(sent).toHaveLength(1);
  });

  test("a restart after Pi saved a result doesn't post it again", async () => {
    const directory = tempDir();
    const first = setup({ idle: true, saves: false });
    const before = await openService({
      parent: first.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await until(() => first.sent.length === 1);
    // Pi saved the message, and pi-agents crashed before it saw it.
    await closeService(before);
    first.session.save(first.sent[0] as Sent);

    const second = setup({ idle: true }, { session: first.session });
    const after = await openService({
      parent: second.parent,
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    service = after;
    await until(() => after.get("a")?.closed === true);
    expect(second.sent).toEqual([]);
  });

  test("a restart before Pi saved a result posts it again", async () => {
    const directory = tempDir();
    const first = setup({ idle: true, saves: false });
    const before = await openService({
      parent: first.parent,
      storage: await jsonlStorage(directory),
    });
    service = before;
    await before.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await until(() => first.sent.length === 1);
    await closeService(before);

    const second = setup({ idle: true }, { session: first.session });
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
    const state = { idle: false };
    const { sent, parent, session } = setup(state);
    const current = await openService({ parent });
    service = current;
    await current.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    session.issue("toolu_1");
    const outcome = await current.wait(["a"], {
      carrier: true,
    });
    expect(outcome.deliveries).toHaveLength(1);

    // Until Pi stored the call's result, the result is neither delivered
    // nor posted, even once Pi is idle.
    state.idle = true;
    parent.notify();
    await settle();
    expect(sent).toEqual([]);
    expect(current.get("a")?.queued).toBeUndefined();
    expect(current.get("a")?.closed).toBe(false);

    session.store("toolu_1", { deliveries: outcome.deliveries });
    parent.notify();
    await until(() => current.get("a")?.closed === true);
    expect(sent).toEqual([]);
  });

  test.each([false, true])(
    "nested wait metadata never confirms delivery (carrier error: %s)",
    async (isError) => {
      const { parent, session } = setup({ idle: true });
      session.issue("toolu_2", "codemode");
      // Nested-call metadata proves neither delivery nor model context.
      session.store("toolu_2", { nested: ["toolu_2/1"], isError });
      expect(await parent.received([{ id: "delivery" }])).toEqual(new Set());
    },
  );

  test.each([false, true])(
    "a wait survives restart (saved: %s)",
    async (saved) => {
      const directory = tempDir();
      const first = setup({ idle: false });
      const before = await openService({
        parent: first.parent,
        storage: await jsonlStorage(directory),
      });
      service = before;
      await before.spawnGraph({
        agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
      });
      first.session.issue("toolu_3");
      const outcome = await before.wait(["a"], {
        carrier: true,
      });
      await closeService(before);
      if (saved)
        first.session.store("toolu_3", { deliveries: outcome.deliveries });

      const second = setup({ idle: true }, { session: first.session });
      const after = await openService({
        parent: second.parent,
        storage: await jsonlStorage(directory),
        models: createFaux().models,
      });
      service = after;
      await until(() => after.get("a")?.closed === true);
      expect(second.sent.map((message) => message.details?.delivery)).toEqual(
        saved ? [] : outcome.deliveries,
      );
    },
  );
});
