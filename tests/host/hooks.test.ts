import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as CONTEXT } from "@earendil-works/chord/context";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, ProviderDoc } from "@earendil-works/pi-durable";
import { AgentsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import type {
  AgentBeforeRequestContext,
  AgentHooks,
  AgentRequestContext,
} from "../../src/hooks.js";
import { AgentRequestHooks } from "../../src/host/hooks.js";
import {
  briefly,
  closeService,
  createFaux,
  hostOf,
  jsonlStorage,
  lastUserText,
  MODEL,
  openService,
  tempDir,
  until,
} from "../agents/helpers.js";

let services: AgentService[] = [];
afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

/** Faux providers leave payload handling to the response factory. */
function provider() {
  const { faux, models } = createFaux();
  const payloads: unknown[] = [];
  const step: FauxResponseFactory = async (context, options, _state, model) => {
    const payload = await options?.onPayload?.({ original: true }, model);
    payloads.push(payload);
    const last = context.messages.at(-1);
    if (last?.role === "user" && lastUserText(context) === "delegate")
      return fauxAssistantMessage(
        [
          fauxToolCall("agent_spawn", {
            agents: [{ name: "helper", job: "help" }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("done");
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return { models, faux, payloads };
}

const spawn = (name: string, job = name) => ({
  name,
  job,
  cwd: ".",
  tools: [],
  model: MODEL,
});

async function open(options: Parameters<typeof openService>[0]) {
  const service = await openService(options);
  services.push(service);
  return service;
}

const observe = (seen: AgentRequestContext[]): AgentHooks => ({
  namespace: "example",
  onAgentRequest(ctx, payload) {
    seen.push(ctx);
    expect(Object.isFrozen(ctx.state)).toBe(true);
    return { ...(payload as object), settings: ctx.state };
  },
});

describe("agent lifecycle hooks", () => {
  test("snapshots follow agents, graphs, spawned agents, compaction, and reopening", async () => {
    const directory = tempDir();
    const { models, payloads } = provider();
    const seen: AgentRequestContext[] = [];
    let captures = 0;
    let setting = "first";
    const captureExtensionState = () => {
      captures++;
      return { example: { setting } };
    };
    let service = await open({
      models,
      storage: await jsonlStorage(directory),
      hooks: [observe(seen)],
      captureExtensionState,
      settings: { compaction: { keepRecentTokens: 0 } },
    });
    const lead = await service
      .spawnGraph({
        agents: [
          {
            ...spawn("lead", "delegate"),
            spawn: true,
          },
        ],
      })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    await service.wait([lead]);
    expect(captures).toBe(1); // Spawned agents copy state; they never capture from Pi.
    expect(seen.some((ctx) => ctx.agent.name === "lead.helper")).toBe(true);
    expect(seen.every((ctx) => ctx.state?.setting === "first")).toBe(true);
    setting = "second";
    const graph = await service.spawnGraph({
      agents: [spawn("a"), { ...spawn("b"), after: ["a"] }],
    });
    setting = "third";
    await service.wait([graph.id]);
    expect(captures).toBe(2); // One snapshot for the whole graph.
    expect(
      seen
        .filter((ctx) => ["a", "b"].includes(ctx.agent.name))
        .every((ctx) => ctx.state?.setting === "second"),
    ).toBe(true);

    const harness = hostOf(service).harness.harness;
    const conversation = await harness.conversation(
      Number(lead) as ConversationId,
      CONTEXT,
    );
    if (!conversation) throw new Error("Missing lead conversation");
    const before = seen.length;
    const task = await conversation.compact(undefined, CONTEXT);
    await harness.waitForTask(task, CONTEXT);
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.at(-1)?.state).toEqual({ setting: "first" });
    expect(payloads.at(-1)).toEqual({
      original: true,
      settings: { setting: "first" },
    });

    await closeService(service);
    services = [];
    service = await open({
      models,
      storage: await jsonlStorage(directory),
      hooks: [observe(seen)],
      captureExtensionState,
    });
    await service.send(lead, "again");
    await service.wait([lead]);
    expect(captures).toBe(2);
    expect(seen.at(-1)?.state).toEqual({ setting: "first" });
    expect(seen.at(-1)?.sessionId).toBe("test-parent");
  });

  test("before-request hooks hold model calls; stopping ends a hold", async () => {
    const { models, payloads } = provider();
    const seen: AgentBeforeRequestContext[] = [];
    let release!: () => void;
    let hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = await open({
      models,
      captureExtensionState: () => ({ gate: { peak: true } }),
      hooks: [
        {
          namespace: "gate",
          // Ignores its signal, which must not block a stop.
          beforeAgentRequest: (ctx) => {
            seen.push(ctx);
            return hold;
          },
        },
      ],
    });
    const info = await service
      .spawnGraph({ agents: [spawn("held")] })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    await until(() => seen.length === 1);
    await briefly(undefined, 50);
    expect(payloads).toHaveLength(0);
    expect(service.get(info)?.state).toBe("working");
    expect(seen[0]).toMatchObject({
      sessionId: "test-parent",
      agent: { id: info, name: "held" },
      model: { provider: MODEL.provider, id: MODEL.modelId },
      operation: "generation",
      state: { peak: true },
    });
    release();
    await service.wait([info]);
    expect(payloads).toHaveLength(1);

    hold = new Promise(() => {});
    await service.send(info, "again");
    await until(() => seen.length === 2);
    await service.stop(info);
    await until(() => service.get(info)?.state !== "working");
    expect(payloads).toHaveLength(1);
  });

  test("capture failure creates no partial graph; missing adapters retain state", async () => {
    let captures = 0;
    const service = await open({
      captureExtensionState: () => {
        if (++captures === 1) throw new Error("capture failed");
        return { absent: { version: 1 } };
      },
    });
    await expect(
      service.spawnGraph({ agents: [spawn("one"), spawn("two")] }),
    ).rejects.toThrow("capture failed");
    expect(service.list({ includeClosed: true })).toEqual([]);
    const info = await service
      .spawnGraph({ agents: [spawn("ordinary")] })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    await service.wait([info]);
    const state = await hostOf(service).harness.harness.snapshot(
      AgentsDoc,
      CONTEXT,
    );
    expect(state?.agents[info]?.extensionState).toEqual({
      absent: { version: 1 },
    });
  });

  test("request callbacks compose, see actual models and undefined state, and propagate failures", async () => {
    const { models, faux, payloads } = provider();
    const service = await open({ models });
    const info = await service
      .spawnGraph({ agents: [spawn("legacy")] })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    await service.wait([info]);
    const harness = hostOf(service).harness.harness;
    const identity = await harness.snapshot(
      ProviderDoc,
      Number(info) as ConversationId,
      CONTEXT,
    );
    if (!identity) throw new Error("Missing provider identity");
    let fail = false;
    let hold = false;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const facade = new AgentRequestHooks(models, "owner", [
      {
        namespace: "constructor", // An absent state must not read Object.prototype.
        async onAgentRequest(ctx, payload) {
          expect(ctx.state).toBeUndefined();
          expect(ctx.model.id).toBe("actual-dispatch");
          expect(payload).toBeNull();
          if (fail) throw new Error("do not dispatch");
          if (hold) {
            entered();
            await new Promise(() => {});
          }
          return { applied: true };
        },
      },
      {
        namespace: "last",
        onAgentRequest: (_ctx, payload) => ({
          ...(payload as object),
          last: true,
        }),
      },
    ]);
    await facade.start(harness);
    faux.setResponses(
      Array.from(
        { length: 10 },
        () => async (_context, options, _state, model) => {
          const payload = await options?.onPayload?.(
            {},
            { ...model, id: "actual-dispatch" },
          );
          payloads.push(payload);
          return fauxAssistantMessage("ok");
        },
      ),
    );
    const options = { sessionId: identity.sessionId, onPayload: () => null };
    try {
      const model = faux.getModel();
      await facade.models
        .streamSimple(model, { messages: [] }, options)
        .result();
      await facade.models.completeSimple(model, { messages: [] }, options);
      expect(payloads.slice(-2)).toEqual([
        { applied: true, last: true },
        { applied: true, last: true },
      ]);
      fail = true;
      const failed = await facade.models.completeSimple(
        model,
        { messages: [] },
        options,
      );
      expect(failed.stopReason).toBe("error");
      expect(failed.errorMessage).toContain(
        "constructor: onAgentRequest failed: do not dispatch",
      );
      fail = false;
      hold = true;
      const controller = new AbortController();
      const result = facade.models.completeSimple(
        model,
        { messages: [] },
        { ...options, signal: controller.signal },
      );
      await waiting;
      controller.abort();
      // Faux reports callback exceptions as errors, including abort reasons.
      expect((await result).errorMessage).toContain("abort");
    } finally {
      facade.dispose();
    }
  });
});
