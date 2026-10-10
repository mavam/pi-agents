import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import { GRAPH_RESULT_MESSAGE, RESULT_MESSAGE } from "../../src/pi/messages.js";
import { PiParent } from "../../src/pi/parent.js";
import { closeService, MODEL, openService, until } from "../agents/helpers.js";

interface Sent {
  customType: string;
  content: string;
  options?: { triggerTurn?: boolean };
}

let service: AgentService | undefined;

afterEach(async () => {
  if (service) await closeService(service);
  service = undefined;
});

/** A Pi parent over a fake session whose state the test controls. */
function setup(state: { idle: boolean; pending: boolean }) {
  const sent: Sent[] = [];
  const pi = {
    sendMessage: (
      message: { customType: string; content: string },
      options?: { triggerTurn?: boolean },
    ) => sent.push({ ...message, ...(options ? { options } : {}) }),
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
  } as unknown as ExtensionContext;
  const parent = new PiParent(pi);
  parent.setContext(ctx);
  return { sent, parent };
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
