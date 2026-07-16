import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { type RunView, rebuildRunState } from "../../src/run/state.js";
import { formatRunWidget, widgetProgress } from "../../src/ui/widget.js";

const REVIEW_FLOW = {
  kind: "par",
  branches: {
    bugs: { kind: "agent", name: "reviewer", task: "bugs" },
    clarity: { kind: "agent", name: "reviewer", task: "clarity" },
  },
  reduce: { agent: "worker", task: "merge {branches}" },
};

async function recordedRun(
  raw: unknown,
  handler: (agent: string, task: string) => string,
  keep: (event: RunEvent) => boolean = () => true,
): Promise<RunView> {
  const flow = validateFlow(raw);
  const events: RunEvent[] = [];
  await executeFlow({
    runId: "w1",
    flow,
    label: "review",
    runAgent: async (call) => ({ text: handler(call.agent, call.task) }),
    emit: (event) => events.push(event),
  });
  const run = rebuildRunState(events.filter(keep)).runs.get("w1");
  if (!run) throw new Error("missing run");
  return run;
}

describe("formatRunWidget", () => {
  test("completed run shows a full bar and all-green segments", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const [line1, line2] = formatRunWidget(run, run.createdAt + 92_000, 3);
    expect(line1).toContain("▰▰▰▰▰▰▰▰▰▰");
    expect(line1).toContain("100%");
    expect(line1).toContain("review");
    expect(line1).toContain("w1".length === 2 ? "w1" : "w1"); // shortId of "w1"
    expect(line1).toContain("1m32s");
    expect(line2).toContain("● bugs→reviewer");
    expect(line2).toContain("● clarity→reviewer");
    expect(line2).toContain("● ⑂reduce→worker");
  });

  test("mid-run shows partial bar and a running segment", async () => {
    // Drop the reduce completion and everything after: reduce stays running.
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        return !event.instance.endsWith(".reduce") && event.instance !== "$";
      },
    );
    const { done, total } = widgetProgress(run);
    expect(total).toBe(3);
    expect(done).toBe(2);
    const [line1, line2] = formatRunWidget(run, run.createdAt + 5_000, 0);
    expect(line1).toContain("▱");
    expect(line1).toContain("67%");
    expect(line2).toContain("◉ ⑂reduce→worker");
  });

  test("pending skeleton leaves keep the denominator honest before start", async () => {
    // Replay only run_created: nothing has started yet.
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) => event.type === "run_created",
    );
    const { total } = widgetProgress(run);
    // Even with no node events, the static skeleton knows 3 agents.
    expect(total).toBe(3);
    const [line1, line2] = formatRunWidget(run, run.createdAt, 0);
    expect(line1).toContain("0%");
    expect(line2).toContain("○ bugs→reviewer");
  });

  test("map fan-out aggregates counts into one segment", async () => {
    const run = await recordedRun(
      {
        kind: "seq",
        steps: [
          {
            kind: "agent",
            name: "scout",
            task: "list",
            output: "json",
            as: "files",
          },
          {
            kind: "map",
            over: "{files}",
            body: { kind: "agent", name: "reviewer", task: "review {item}" },
          },
        ],
      },
      (agent) => (agent === "scout" ? '["a","b","c"]' : "ok"),
    );
    const [line1, line2] = formatRunWidget(run, run.createdAt + 1000, 0);
    expect(line2).toContain("● scout→{files}");
    expect(line2).toContain("⇶map {files} [3/3]");
    // 1 scout + 3 map items = 4 agents total.
    expect(widgetProgress(run)).toEqual({ done: 4, total: 4 });
    expect(line1).toContain("100%");
  });

  test("failures color the segment with ✗", async () => {
    const flow = {
      kind: "par",
      onError: "collect",
      branches: {
        good: { kind: "agent", name: "a", task: "t" },
        bad: { kind: "agent", name: "b", task: "t" },
      },
    };
    const run = await recordedRun(flow, (agent) => {
      if (agent === "b") throw new Error("boom");
      return "ok";
    });
    const [, line2] = formatRunWidget(run, run.createdAt, 0);
    expect(line2).toContain("✗ bad→b");
    expect(line2).toContain("● good→a");
  });

  test("live tokens sum completed and streaming usage", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    for (const node of run.nodes.values()) {
      if (node.kind === "agent" || node.kind === "reduce") {
        node.usage = {
          input: 1000,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        };
      }
    }
    const [line1] = formatRunWidget(run, run.createdAt, 0);
    expect(line1).toContain("4.5k tok");
  });

  test("segment overflow collapses into a counter", async () => {
    const run = await recordedRun(
      {
        kind: "seq",
        steps: Array.from({ length: 8 }, (_, i) => ({
          kind: "agent",
          name: `a${i}`,
          task: "t",
        })),
      },
      () => "ok",
    );
    const [, line2] = formatRunWidget(run, run.createdAt, 0);
    expect(line2).toContain("…+3");
  });
});
