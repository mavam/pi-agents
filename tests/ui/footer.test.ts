import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SpawnUsage } from "../../src/engine/types.js";
import type { RunManager } from "../../src/run/runs.js";
import type { NodeView, RunView } from "../../src/run/state.js";
import {
  FancyFooterRunReporter,
  formatFancyFooterRunSummary,
} from "../../src/ui/footer.js";

const usage = (input: number, output: number): SpawnUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 1,
});

function activeRun(): RunView {
  const completed: NodeView = {
    path: "$.branches.done",
    instance: "$.branches.done",
    kind: "agent",
    agent: "worker",
    status: "completed",
    usage: usage(1_000, 500),
    steering: [],
    startedAt: 1,
    endedAt: 2,
  };
  const running: NodeView = {
    path: "$.branches.live",
    instance: "$.branches.live",
    kind: "agent",
    agent: "worker",
    status: "running",
    progressUsage: usage(400, 100),
    steering: [],
    startedAt: 1,
  };
  return {
    header: {
      id: "r1",
      label: "review",
      source: { kind: "command" },
      flow: {
        kind: "parallel",
        branches: {
          done: { kind: "agent", task: "done" },
          live: { kind: "agent", task: "live" },
        },
      },
      depth: 0,
    },
    status: "running",
    nodes: new Map([
      [completed.instance, completed],
      [running.instance, running],
    ]),
    order: [completed.instance, running.instance],
    loopIterations: new Map(),
    backgrounded: true,
    createdAt: 1,
  };
}

class TestEventBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit = (channel: string, data: unknown): void => {
    this.emitted.push({ channel, data });
    this.receive(channel, data);
  };

  on = (channel: string, handler: (data: unknown) => void): (() => void) => {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  };

  receive(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

describe("fancy footer run summary", () => {
  test("summarizes active progress and live tokens without a clock", () => {
    const run = activeRun();
    expect(formatFancyFooterRunSummary([run])).toBe(
      "1 run · 1/2 agents · 2.0k tok",
    );
    run.status = "completed";
    expect(formatFancyFooterRunSummary([run])).toBe("");
  });

  test("publishes an opt-in snapshot, deduplicates, and republishes on ready", () => {
    const bus = new TestEventBus();
    const run = activeRun();
    const manager = {
      state: { runs: new Map([[run.header.id, run]]), order: [run.header.id] },
    } as RunManager;
    const reporter = new FancyFooterRunReporter(
      { events: bus } as unknown as ExtensionAPI,
      manager,
    );

    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0]).toMatchObject({
      channel: "pi-fancy-footer:widget",
      data: {
        protocol: 1,
        type: "upsert",
        widget: {
          id: "pi-agents.runs",
          content: { type: "text", text: "1 run · 1/2 agents · 2.0k tok" },
          layout: { enabled: false, row: 1, position: 9 },
        },
      },
    });

    reporter.update();
    expect(bus.emitted).toHaveLength(1);

    bus.receive("pi-fancy-footer:ready", { protocol: 2, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(1);
    bus.receive("pi-fancy-footer:ready", { protocol: 1, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(2);

    reporter.dispose();
    expect(bus.emitted.at(-1)).toEqual({
      channel: "pi-fancy-footer:widget",
      data: { protocol: 1, type: "remove", id: "pi-agents.runs" },
    });
    bus.receive("pi-fancy-footer:ready", { protocol: 1, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(3);
  });
});
