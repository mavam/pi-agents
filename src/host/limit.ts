/**
 * A cap on the model requests agents make at once, for model servers that
 * serve one request at a time, such as local LLMs. Requests over the cap wait
 * in order of arrival before they reach the provider; tools still run in
 * parallel. pi-durable sends every request through the `Models` it gets, so
 * wrapping it covers agents, graph nodes, helpers, and compaction alike.
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Models,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** The settings key under which pi-agents reads its configuration. */
export const SETTINGS_KEY = "piAgents";

/** Why a waiting request didn't get a slot: it was aborted first. */
class Aborted extends Error {
  constructor() {
    super("Request was aborted while waiting for a slot");
  }
}

/** A FIFO counting semaphore. Without a limit, every request runs at once. */
export class RequestLimiter {
  private active = 0;
  private readonly waiting: {
    admit: () => void;
    signal?: AbortSignal;
  }[] = [];

  constructor(readonly limit: number | undefined) {}

  /** Requests that hold a slot. */
  get running(): number {
    return this.active;
  }

  /** Requests that wait for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Wait for a slot and return its release, which is safe to call twice.
   * Rejects with `Aborted` when `signal` aborts first; the place in line
   * goes to the next request.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Aborted());
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        admit: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.pump();
          });
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(new Aborted());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    while (
      this.waiting.length > 0 &&
      (this.limit === undefined || this.active < this.limit)
    ) {
      this.waiting.shift()?.admit();
    }
  }
}

type StreamArgs = Parameters<Models["streamSimple"]>;

/** The message a request ends with when it's aborted while it waits. */
function abortedMessage(model: StreamArgs[0]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

function errorMessage(model: StreamArgs[0], error: unknown): AssistantMessage {
  return {
    ...abortedMessage(model),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

/**
 * `models` with `streamSimple` and `completeSimple` held to the limiter's
 * cap. Everything else passes through to `models` unchanged. Without a limit,
 * returns `models` itself.
 */
export function limitRequests(models: Models, limiter: RequestLimiter): Models {
  if (limiter.limit === undefined) return models;

  const streamSimple = (...args: StreamArgs): AssistantMessageEventStream => {
    const [model, , options] = args;
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let release: () => void;
      try {
        release = await limiter.acquire(options?.signal);
      } catch {
        // Only an abort rejects a wait.
        const message = abortedMessage(model);
        outer.push({ type: "error", reason: "aborted", error: message });
        outer.end();
        return;
      }
      try {
        const inner = models.streamSimple(...args);
        for await (const event of inner) {
          // Free the slot before the caller sees the answer.
          if (event.type === "done" || event.type === "error") release();
          outer.push(event);
        }
        outer.end(await inner.result());
      } catch (error) {
        const message = errorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end();
      } finally {
        release();
      }
    })();
    return outer;
  };

  const completeSimple: Models["completeSimple"] = async (...args) => {
    const [model, , options] = args;
    let release: () => void;
    try {
      release = await limiter.acquire(options?.signal);
    } catch {
      return abortedMessage(model);
    }
    try {
      return await models.completeSimple(...args);
    } finally {
      release();
    }
  };

  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      if (key === "completeSimple") return completeSimple;
      // Bound to the original, so its own internal calls don't take a
      // second slot.
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The request limit from Pi's merged settings: `piAgents.maxConcurrentRequests`.
 * Absent means no limit; anything but a positive integer is an error, and
 * pi-agents then runs without a limit.
 */
export function readRequestLimit(settings: unknown): {
  limit?: number;
  error?: string;
} {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section))
    return { error: `${SETTINGS_KEY} must be an object` };
  const value = (section as Record<string, unknown>).maxConcurrentRequests;
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return {
      error: `${SETTINGS_KEY}.maxConcurrentRequests must be a positive integer, not ${JSON.stringify(value)}`,
    };
  return { limit: value };
}
