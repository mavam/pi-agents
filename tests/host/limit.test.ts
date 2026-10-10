import { afterEach, describe, expect, test } from "bun:test";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentService } from "../../src/agents/service.js";
import {
  limitRequests,
  RequestLimiter,
  readRequestLimit,
} from "../../src/host/limit.js";
import {
  closeService,
  createFaux,
  MODEL,
  openService,
  until,
} from "../agents/helpers.js";

/** `models` that count the requests reaching the provider at once. */
function counting(models: Models) {
  const stats = { active: 0, peak: 0, started: 0 };
  const track = <T>(result: Promise<T>) => {
    stats.active += 1;
    stats.started += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    void result.finally(() => {
      stats.active -= 1;
    });
  };
  const wrapped = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple")
        return (...args: Parameters<Models["streamSimple"]>) => {
          const stream = target.streamSimple(...args);
          track(stream.result());
          return stream;
        };
      if (key === "completeSimple")
        return (...args: Parameters<Models["completeSimple"]>) => {
          const result = target.completeSimple(...args);
          track(result);
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models: wrapped, stats };
}

function slowFaux() {
  const { models } = createFaux(undefined, { tokensPerSecond: 200 });
  const model = models.getModel(MODEL.provider, MODEL.modelId);
  if (!model) throw new Error("no faux model");
  return { models, model };
}

const context = {
  messages: [
    { role: "user" as const, content: "hello there", timestamp: Date.now() },
  ],
};

test("the limit comes from piAgents.maxConcurrentRequests", () => {
  expect(readRequestLimit({})).toEqual({});
  expect(readRequestLimit({ piAgents: { maxConcurrentRequests: 4 } })).toEqual({
    limit: 4,
  });
  for (const value of [0, 1.5, "1"]) {
    const { limit, error } = readRequestLimit({
      piAgents: { maxConcurrentRequests: value },
    });
    expect(limit).toBeUndefined();
    expect(error).toContain("positive integer");
  }
});

test("requests over the limit wait in order of arrival", async () => {
  const limiter = new RequestLimiter(1);
  const order: string[] = [];
  const first = await limiter.acquire();
  const second = limiter.acquire().then((release) => {
    order.push("second");
    return release;
  });
  const third = limiter.acquire().then((release) => {
    order.push("third");
    return release;
  });
  await Promise.resolve();
  expect(order).toEqual([]);
  first();
  (await second)();
  (await third)();
  expect(order).toEqual(["second", "third"]);
});

test("a request aborted while waiting ends as aborted and frees its place", async () => {
  const { models: faux, model } = slowFaux();
  const { models, stats } = counting(faux);
  const limiter = new RequestLimiter(1);
  const limited = limitRequests(models, limiter);
  const first = limited.streamSimple(model, context);
  const controller = new AbortController();
  const waiting = limited.streamSimple(model, context, {
    signal: controller.signal,
  });
  controller.abort();
  expect((await waiting.result()).stopReason).toBe("aborted");
  expect((await first.result()).stopReason).toBe("stop");
  expect(stats.started).toBe(1);
  expect(limiter.queued).toBe(0);
});

test("compaction requests count toward the limit", async () => {
  const { models: faux, model } = slowFaux();
  const { models, stats } = counting(faux);
  const limited = limitRequests(models, new RequestLimiter(1));
  await Promise.all([
    limited.completeSimple(model, context),
    limited.completeSimple(model, context),
  ]);
  expect(stats.started).toBe(2);
  expect(stats.peak).toBe(1);
});

describe("agents with a request limit", () => {
  let service: AgentService | undefined;

  afterEach(async () => {
    if (service) await closeService(service);
    service = undefined;
  });

  test("agents take turns at the model and all answer", async () => {
    const { models: faux } = slowFaux();
    const { models, stats } = counting(faux);
    service = await openService({
      models: limitRequests(models, new RequestLimiter(1)) as typeof faux,
    });
    for (const name of ["a", "b", "c"])
      await service.spawn({ task: name, name, cwd: ".", model: MODEL });
    const current = service;
    await until(() => current.pendingDeliveries().length === 3, 10_000);
    for (const delivery of current.pendingDeliveries())
      expect(delivery.outcome.kind).toBe("answered");
    expect(stats.started).toBe(3);
    expect(stats.peak).toBe(1);
  });
});
