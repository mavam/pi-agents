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

describe("readRequestLimit", () => {
  test("reads piAgents.maxConcurrentRequests", () => {
    expect(readRequestLimit({})).toEqual({});
    expect(readRequestLimit({ piAgents: {} })).toEqual({});
    expect(
      readRequestLimit({ piAgents: { maxConcurrentRequests: 1 } }),
    ).toEqual({ limit: 1 });
    expect(
      readRequestLimit({ piAgents: { maxConcurrentRequests: 4 } }),
    ).toEqual({ limit: 4 });
  });

  test("rejects anything but a positive integer", () => {
    for (const value of [0, -1, 1.5, "1", null, true]) {
      const { limit, error } = readRequestLimit({
        piAgents: { maxConcurrentRequests: value },
      });
      expect(limit).toBeUndefined();
      expect(error).toContain("positive integer");
    }
    expect(readRequestLimit({ piAgents: 1 }).error).toContain("object");
  });
});

describe("RequestLimiter", () => {
  test("admits up to the limit, then in order of arrival", async () => {
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
    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(2);
    first();
    first(); // A second release changes nothing.
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
    expect(limiter.running).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test("an aborted wait gives up its place", async () => {
    const limiter = new RequestLimiter(1);
    const first = await limiter.acquire();
    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    const next = limiter.acquire();
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(limiter.queued).toBe(1);
    first();
    (await next)();
    expect(limiter.running).toBe(0);
  });

  test("without a limit, nothing waits", async () => {
    const limiter = new RequestLimiter(undefined);
    const releases = await Promise.all(
      Array.from({ length: 5 }, () => limiter.acquire()),
    );
    expect(limiter.running).toBe(5);
    for (const release of releases) release();
  });
});

describe("limitRequests", () => {
  test("returns the models unchanged without a limit", () => {
    const { models } = slowFaux();
    expect(limitRequests(models, new RequestLimiter(undefined))).toBe(models);
  });

  test("streams one request at a time with a limit of 1", async () => {
    const { models: faux, model } = slowFaux();
    const { models, stats } = counting(faux);
    const limited = limitRequests(models, new RequestLimiter(1));
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        limited.streamSimple(model, context).result(),
      ),
    );
    expect(results.map((message) => message.stopReason)).toEqual([
      "stop",
      "stop",
      "stop",
    ]);
    expect(stats.started).toBe(3);
    expect(stats.peak).toBe(1);
  });

  test("forwards every event of the stream", async () => {
    const { models, model } = slowFaux();
    const limited = limitRequests(models, new RequestLimiter(1));
    const types: string[] = [];
    for await (const event of limited.streamSimple(model, context))
      types.push(event.type);
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("done");
  });

  test("a request aborted while waiting ends as aborted", async () => {
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
    const message = await waiting.result();
    expect(message.stopReason).toBe("aborted");
    expect((await first.result()).stopReason).toBe("stop");
    expect(stats.started).toBe(1);
    expect(limiter.running).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test("limits completeSimple too", async () => {
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
