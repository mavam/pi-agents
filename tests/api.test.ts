import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiAgentsClient,
  PROTOCOL_VERSION,
  READY_CHANNEL,
  RPC_REPLY_PREFIX,
  RPC_REQUEST_CHANNEL,
  type RpcRequest,
  RUN_EVENT_CHANNEL,
} from "pi-agents/api";

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

  count(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }
}

function makePi(bus: TestBus): ExtensionAPI {
  return { events: bus } as unknown as ExtensionAPI;
}

describe("public pi-agents client", () => {
  test("uses the current event and RPC protocol", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  test("handles a synchronous correlated reply and sends caller identity", async () => {
    const bus = new TestBus();
    let request!: RpcRequest;
    bus.on(RPC_REQUEST_CHANNEL, (raw) => {
      request = raw as RpcRequest;
      bus.emit(`${RPC_REPLY_PREFIX}${request.id}`, {
        protocol: PROTOCOL_VERSION,
        id: request.id,
        success: true,
        data: { protocol: PROTOCOL_VERSION, version: "0.3.0" },
      });
    });
    const client = createPiAgentsClient(makePi(bus), {
      caller: "test-extension",
    });
    expect(await client.ping()).toEqual({
      protocol: PROTOCOL_VERSION,
      version: "0.3.0",
    });
    expect(request.op).toBe("ping");
    expect(request.caller).toBe("test-extension");
    expect(bus.count(`${RPC_REPLY_PREFIX}${request.id}`)).toBe(0);
  });

  test("correlates concurrent requests", async () => {
    const bus = new TestBus();
    const requests: RpcRequest[] = [];
    bus.on(RPC_REQUEST_CHANNEL, (raw) => requests.push(raw as RpcRequest));
    const client = createPiAgentsClient(makePi(bus));
    const first = client.list();
    const second = client.list();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
    for (const request of [...requests].reverse()) {
      bus.emit(`${RPC_REPLY_PREFIX}${request.id}`, {
        protocol: PROTOCOL_VERSION,
        id: request.id,
        success: true,
        data: {
          runs: [
            { runId: request.id, status: "running", source: { kind: "rpc" } },
          ],
        },
      });
    }
    expect((await first).runs[0]?.runId).toBe(requests[0]?.id);
    expect((await second).runs[0]?.runId).toBe(requests[1]?.id);
  });

  test("sends a display path with a typed start request", async () => {
    const bus = new TestBus();
    let request!: RpcRequest;
    bus.on(RPC_REQUEST_CHANNEL, (raw) => {
      request = raw as RpcRequest;
      bus.emit(`${RPC_REPLY_PREFIX}${request.id}`, {
        protocol: PROTOCOL_VERSION,
        id: request.id,
        success: true,
        data: { runId: "run-1" },
      });
    });
    const client = createPiAgentsClient(makePi(bus));

    await expect(
      client.start({
        flow: { kind: "agent", task: "review" },
        display: "summary",
      }),
    ).resolves.toEqual({ runId: "run-1" });
    expect(request).toMatchObject({
      op: "start",
      params: {
        flow: { kind: "agent", task: "review" },
        display: "summary",
      },
    });
  });

  test("times out and removes its reply listener", async () => {
    const bus = new TestBus();
    let request!: RpcRequest;
    bus.on(RPC_REQUEST_CHANNEL, (raw) => {
      request = raw as RpcRequest;
    });
    const client = createPiAgentsClient(makePi(bus), { timeoutMs: 5 });
    await expect(client.ping()).rejects.toThrow("timed out");
    expect(bus.count(`${RPC_REPLY_PREFIX}${request.id}`)).toBe(0);
  });

  test("filters malformed event envelopes and unsubscribes", () => {
    const bus = new TestBus();
    const client = createPiAgentsClient(makePi(bus));
    const types: string[] = [];
    const ready: string[] = [];
    const offEvent = client.onRunEvent((event) => types.push(event.type));
    const offReady = client.onReady((event) => ready.push(event.version));
    bus.emit(RUN_EVENT_CHANNEL, { protocol: 99, event: { type: "bad" } });
    bus.emit(RUN_EVENT_CHANNEL, {
      protocol: PROTOCOL_VERSION,
      event: {
        type: "node_model",
        at: 1,
        runId: "r",
        path: "$",
        instance: "$",
        model: "openai/gpt-5",
      },
    });
    bus.emit(READY_CHANNEL, { protocol: PROTOCOL_VERSION, version: "1.0.0" });
    expect(types).toEqual(["node_model"]);
    expect(ready).toEqual(["1.0.0"]);
    offEvent();
    offReady();
    expect(bus.count(RUN_EVENT_CHANNEL)).toBe(0);
    expect(bus.count(READY_CHANNEL)).toBe(0);
  });
});
