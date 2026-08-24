import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  READY_CHANNEL,
  RUN_EVENT_CHANNEL,
} from "../../src/api.js";
import type { SpawnEngine } from "../../src/engine/types.js";
import { emptyUsage } from "../../src/engine/types.js";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import {
  createRunEventPublisher,
  publishReady,
} from "../../src/run/publish.js";
import { RunManager } from "../../src/run/runs.js";

async function* emptyUpdates(): AsyncGenerator<never> {}

const engine: SpawnEngine = {
  spawn() {
    return {
      status: "completed",
      updates: emptyUpdates(),
      wait: async () => ({ value: "ok", exitCode: 0, usage: emptyUsage() }),
      abort: () => {},
    };
  },
};

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(`${os.tmpdir()}/pi-agents-publish-`);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("run event publisher", () => {
  test("publishes a detached, deeply frozen snapshot", () => {
    const original: RunEvent = {
      type: "run_created",
      at: 1,
      run: {
        id: "run-1",
        label: "original",
        source: { kind: "tool" },
        flow: { kind: "agent", task: "hello" },
        depth: 0,
      },
    };
    const pi = {
      events: {
        on: () => () => {},
        emit: (channel: string, raw: unknown) => {
          expect(channel).toBe(RUN_EVENT_CHANNEL);
          const envelope = raw as {
            protocol: number;
            event: Extract<RunEvent, { type: "run_created" }>;
          };
          expect(envelope.protocol).toBe(PROTOCOL_VERSION);
          expect(envelope.event).not.toBe(original);
          expect(Object.isFrozen(envelope)).toBe(true);
          expect(Object.isFrozen(envelope.event)).toBe(true);
          expect(Object.isFrozen(envelope.event.run)).toBe(true);
          expect(Object.isFrozen(envelope.event.run.source)).toBe(true);
          expect(Object.isFrozen(envelope.event.run.flow)).toBe(true);
          expect(Reflect.set(envelope.event.run, "label", "mutated")).toBe(
            false,
          );
          expect(envelope.event.run.label).toBe("original");
        },
      },
    } as unknown as Pick<ExtensionAPI, "events">;

    createRunEventPublisher(pi)(original);
    expect(original.run.label).toBe("original");
  });

  test("publishes effective-model events unchanged", () => {
    const emissions: unknown[] = [];
    const pi = {
      events: {
        on: () => () => {},
        emit: (_channel: string, data: unknown) => emissions.push(data),
      },
    } as unknown as Pick<ExtensionAPI, "events">;
    const event: RunEvent = {
      type: "node_model",
      at: 1,
      runId: "run-1",
      path: "$",
      instance: "$",
      model: "openai/gpt-5",
    };
    createRunEventPublisher(pi)(event);
    expect(emissions[0]).toMatchObject({
      protocol: PROTOCOL_VERSION,
      event,
    });
  });

  test("swallows cloning and bus failures", () => {
    const pi = {
      events: {
        on: () => () => {},
        emit: () => {
          throw new Error("broken bus");
        },
      },
    } as unknown as Pick<ExtensionAPI, "events">;
    const event: RunEvent = {
      type: "run_completed",
      at: 1,
      runId: "run-1",
      status: "completed",
      usage: emptyUsage(),
      agents: 0,
    };
    expect(() => createRunEventPublisher(pi)(event)).not.toThrow();
  });

  test("publishes ready safely", () => {
    const emissions: Array<[string, unknown]> = [];
    const pi = {
      events: {
        on: () => () => {},
        emit: (channel: string, data: unknown) =>
          emissions.push([channel, data]),
      },
    } as unknown as Pick<ExtensionAPI, "events">;
    publishReady(pi, "1.2.3");
    expect(emissions).toEqual([
      [READY_CHANNEL, { protocol: PROTOCOL_VERSION, version: "1.2.3" }],
    ]);
  });
});

describe("RunManager publication order", () => {
  test("finishes internal sinks before publishing every event", async () => {
    const order: string[] = [];
    let manager!: RunManager;
    manager = new RunManager({
      engine,
      onEvent: (event) => order.push(`internal:${event.type}`),
      onStateChanged: () => order.push("state-changed"),
      publish: (event) => {
        order.push(`publish:${event.type}`);
        const runId = event.type === "run_created" ? event.run.id : event.runId;
        expect(manager.state.runs.has(runId)).toBe(true);
      },
    });
    const started = manager.start({
      flow: validateFlow({ kind: "agent", task: "hello" }),
      cwd: projectDir,
      source: { kind: "tool" },
      onEvent: (event) => order.push(`persist:${event.type}`),
    });
    manager.markBackgrounded(started.runId);
    await started.done;

    for (const type of [
      "run_created",
      "run_backgrounded",
      "node_started",
      "node_completed",
      "run_completed",
    ]) {
      const persist = order.indexOf(`persist:${type}`);
      const internal = order.indexOf(`internal:${type}`);
      const published = order.indexOf(`publish:${type}`);
      expect(persist).toBeGreaterThanOrEqual(0);
      expect(internal).toBeGreaterThan(persist);
      expect(published).toBeGreaterThan(internal);
      expect(order[published - 1]).toBe("state-changed");
    }
  });

  test("a throwing external sink does not fail the run", async () => {
    const manager = new RunManager({
      engine,
      publish: () => {
        throw new Error("subscriber failure");
      },
    });
    const { done } = manager.start({
      flow: validateFlow({ kind: "agent", task: "hello" }),
      cwd: projectDir,
      source: { kind: "tool" },
    });
    expect((await done).status).toBe("completed");
  });
});
