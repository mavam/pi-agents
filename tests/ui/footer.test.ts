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
  test("counts active executions and completed agents without usage", () => {
    const run = activeRun();
    expect(formatFancyFooterRunSummary([run])).toEqual({
      workflows: "1",
      agents: "1/2",
    });
    const second = activeRun();
    second.header = { ...second.header, id: "r2" };
    expect(formatFancyFooterRunSummary([run, second])).toEqual({
      workflows: "2",
      agents: "2/4",
    });
    run.status = "completed";
    expect(formatFancyFooterRunSummary([run])).toEqual({
      workflows: "",
      agents: "",
    });
  });

  test("publishes two opt-in snapshots and deduplicates them independently", () => {
    const bus = new TestEventBus();
    const run = activeRun();
    const manager = {
      state: { runs: new Map([[run.header.id, run]]), order: [run.header.id] },
    } as RunManager;
    const reporter = new FancyFooterRunReporter(
      { events: bus } as unknown as ExtensionAPI,
      manager,
    );

    expect(bus.emitted).toHaveLength(2);
    expect(bus.emitted[0]).toMatchObject({
      channel: "pi-fancy-footer:widget",
      data: {
        protocol: 1,
        type: "upsert",
        widget: {
          id: "pi-agents.workflows",
          label: "workflows",
          content: { type: "text", text: "1" },
          layout: { enabled: false, row: 1, position: 9 },
        },
      },
    });
    expect(bus.emitted[1]).toMatchObject({
      channel: "pi-fancy-footer:widget",
      data: {
        protocol: 1,
        type: "upsert",
        widget: {
          id: "pi-agents.agents",
          label: "agents",
          content: { type: "text", text: "1/2" },
          layout: { enabled: false, row: 1, position: 10 },
        },
      },
    });

    reporter.update();
    expect(bus.emitted).toHaveLength(2);

    const running = run.nodes.get("$.branches.live");
    if (!running) throw new Error("missing running agent");
    running.status = "completed";
    reporter.update();
    expect(bus.emitted).toHaveLength(3);
    expect(bus.emitted.at(-1)).toMatchObject({
      data: {
        widget: {
          id: "pi-agents.agents",
          content: { text: "2/2" },
        },
      },
    });

    bus.receive("pi-fancy-footer:ready", { protocol: 2, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(3);
    bus.receive("pi-fancy-footer:ready", { protocol: 1, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(5);

    reporter.dispose();
    expect(bus.emitted.slice(-2)).toEqual([
      {
        channel: "pi-fancy-footer:widget",
        data: { protocol: 1, type: "remove", id: "pi-agents.workflows" },
      },
      {
        channel: "pi-fancy-footer:widget",
        data: { protocol: 1, type: "remove", id: "pi-agents.agents" },
      },
    ]);
    bus.receive("pi-fancy-footer:ready", { protocol: 1, version: "2.0.0" });
    expect(bus.emitted).toHaveLength(7);
  });
});
