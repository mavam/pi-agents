import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import { DeliveryManager } from "../../src/pi/delivery.js";
import { GRAPH_RESULT_MESSAGE, RESULT_MESSAGE } from "../../src/pi/messages.js";
import type { SessionHost } from "../../src/pi/session.js";
import { MODEL, openService, until } from "../agents/helpers.js";

interface Sent {
  customType: string;
  content: string;
  options?: { triggerTurn?: boolean };
}

let service: AgentService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

function setup(state: { idle: boolean; pending: boolean }) {
  const sent: Sent[] = [];
  const pi = {
    sendMessage: (
      message: { customType: string; content: string },
      options?: { triggerTurn?: boolean },
    ) => sent.push({ ...message, ...(options ? { options } : {}) }),
  } as unknown as ExtensionAPI;
  const host = { current: () => service } as unknown as SessionHost;
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
  } as unknown as ExtensionContext;
  return { sent, delivery: new DeliveryManager(pi, host), ctx };
}

describe("DeliveryManager", () => {
  test("posts results once the parent is idle and wakes it", async () => {
    service = await openService();
    const state = { idle: false, pending: false };
    const { sent, delivery, ctx } = setup(state);
    await service.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await service.spawn({ task: "b", name: "b", cwd: ".", model: MODEL });
    await until(() => service?.pendingDeliveries().length === 2);

    delivery.flush(ctx);
    expect(sent).toEqual([]);

    state.idle = true;
    delivery.flush(ctx);
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
    await until(() => service?.pendingDeliveries().length === 0);
    delivery.flush(ctx);
    expect(sent).toHaveLength(2);
  });

  test("holds results while blocked or while messages are pending", async () => {
    service = await openService();
    const state = { idle: true, pending: true };
    const { sent, delivery, ctx } = setup(state);
    let attached = true;
    delivery.setBlocked(() => attached);
    await service.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await until(() => service?.pendingDeliveries().length === 1);

    delivery.flush(ctx);
    state.pending = false;
    delivery.flush(ctx);
    expect(sent).toEqual([]);

    attached = false;
    delivery.flush(ctx);
    expect(sent).toHaveLength(1);
  });

  test("posts one message per graph with its end agent's answer", async () => {
    service = await openService();
    const state = { idle: true, pending: false };
    const { sent, delivery, ctx } = setup(state);
    await service.spawnGraph({
      name: "pair",
      agents: [
        { name: "a", task: "a", cwd: ".", model: MODEL },
        { name: "merge", task: "merge", cwd: ".", model: MODEL, after: ["a"] },
      ],
    });
    await until(() => service?.pendingDeliveries().length === 1);
    delivery.flush(ctx);
    expect(sent.map((message) => message.customType)).toEqual([
      GRAPH_RESULT_MESSAGE,
    ]);
    // Only the end agent's answer reaches the parent, attributed to it.
    expect(sent[0]?.content).toStartWith("Graph pair: merge answered:\n\n");
    expect(sent[0]?.content).toContain("done: merge");
    expect(sent[0]?.options?.triggerTurn).toBe(true);
    await until(() => service?.pendingDeliveries().length === 0);
    delivery.flush(ctx);
    expect(sent).toHaveLength(1);
    expect(service.getGraph("pair")?.closed).toBe(true);
  });

  test("a graph without edges reports every agent's answer", async () => {
    service = await openService();
    const state = { idle: true, pending: false };
    const { sent, delivery, ctx } = setup(state);
    await service.spawnGraph({
      name: "pair",
      agents: [
        { task: "a", cwd: ".", model: MODEL },
        { task: "b", cwd: ".", model: MODEL },
      ],
    });
    await until(() => service?.pendingDeliveries().length === 1);
    delivery.flush(ctx);
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
