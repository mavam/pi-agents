import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { type RunView, rebuildRunState } from "../../src/run/state.js";
import {
  type Colorize,
  formatRunWidget,
  RunWidget,
  STALL_AFTER_MS,
  widgetProgress,
} from "../../src/ui/widget.js";

/** Tags each colored span so tests can assert glyph colors. */
const tagged: Colorize = (color, text) => `<${color}>${text}</>`;

const REVIEW_FLOW = {
  kind: "parallel",
  branches: {
    bugs: { kind: "agent", name: "reviewer", task: "bugs" },
    clarity: { kind: "agent", name: "reviewer", task: "clarity" },
  },
  reduce: { agent: "worker", task: "merge {branches}" },
};

async function recordedRun(
  raw: unknown,
  handler: (agent: string | undefined, task: string) => string,
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
  test("completed run is one line with 100% and an all-green strip", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const lines = formatRunWidget(run, run.createdAt + 92_000, tagged);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    // The static ❖ run mark leads; no spinner animates.
    expect(line).toContain("<muted>❖</> 100%");
    expect(line).toContain("review");
    expect(line).toContain("1m32s");
    // Two agent branches plus the reducer, all completed.
    expect(line).toContain("<success>◆</><success>◆</><success>⑂</>");
    // Nothing is running, so nothing expands.
    expect(line).not.toContain("⟨");
  });

  test("mid-run shows partial percent and a running glyph", async () => {
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
    const [line] = formatRunWidget(run, run.createdAt + 5_000, tagged);
    expect(line).toContain("67%");
    // Finished branches are green; the running reducer is the warning glyph.
    expect(line).toContain("<success>◆</><success>◆</><warning>⑂</>");
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
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    expect(line).toContain("0%");
    expect(line).toContain("<dim>◆</><dim>◆</><dim>⑂</>");
  });

  test("map fan-out aggregates counts into one segment", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
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
    const [line] = formatRunWidget(run, run.createdAt + 1000);
    expect(line).toContain("◆⇶");
    // 1 scout + 3 map items = 4 agents total.
    expect(widgetProgress(run)).toEqual({ done: 4, total: 4 });
    expect(line).toContain("100%");
  });

  test("switch totals use the smallest arm and self-correct as instances appear", async () => {
    const SWITCH_FLOW = {
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "gate",
          task: "inspect",
          output: "json",
          as: "gate",
        },
        {
          kind: "switch",
          on: "{gate}",
          cases: [
            {
              when: { eq: ["status", "findings"] },
              then: {
                kind: "sequence",
                steps: [
                  { kind: "agent", name: "fixer", task: "fix" },
                  { kind: "agent", name: "checker", task: "recheck" },
                ],
              },
            },
          ],
          else: { kind: "agent", name: "reporter", task: "report" },
        },
      ],
    };
    // Before anything starts, the denominator counts gate + the smallest arm.
    const pending = await recordedRun(
      SWITCH_FLOW,
      (agent) => (agent === "gate" ? '{"status": "findings"}' : "ok"),
      (event) => event.type === "run_created",
    );
    expect(widgetProgress(pending)).toEqual({ done: 0, total: 2 });
    // The larger arm ran: the total grows with the real instances and the
    // finished run still reads 100% (min-arm undercounts, never overcounts).
    const run = await recordedRun(SWITCH_FLOW, (agent) =>
      agent === "gate" ? '{"status": "findings"}' : "ok",
    );
    expect(widgetProgress(run)).toEqual({ done: 3, total: 3 });
    const [line] = formatRunWidget(run, run.createdAt);
    expect(line).toContain("100%");
    expect(line).toContain("◆⎇");
  });

  test("value nodes add no work: zero leaves, ≔ segment", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: [
          {
            kind: "agent",
            name: "scout",
            task: "scan",
            output: "json",
            as: "scout",
          },
          { kind: "value", value: { seen: "{scout.count}" } },
        ],
      },
      () => '{"count": 3}',
    );
    expect(widgetProgress(run)).toEqual({ done: 1, total: 1 });
    const [line] = formatRunWidget(run, run.createdAt);
    expect(line).toContain("100%");
    expect(line).toContain("◆≔");
  });

  test("failed units replace their glyph with ✗", async () => {
    const flow = {
      kind: "parallel",
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
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    expect(line).toContain("<success>◆</><error>✗</>");
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
    const [line1] = formatRunWidget(run, run.createdAt);
    expect(line1).toContain("4.5k");
  });

  test("the active agent's output excerpt joins line 1", async () => {
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        return !event.instance.endsWith(".reduce") && event.instance !== "$";
      },
    );
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressText = "Merging findings into one prioritized list\nmore";
      }
    }
    const [line1] = formatRunWidget(run, run.createdAt + 1000);
    expect(line1).toContain("· Merging findings into one prioritized list");
    expect(line1).not.toContain("more");
  });

  test("deep flows collapse to one glyph per top-level step", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: [
          {
            kind: "agent",
            name: "explorer",
            task: "map",
            output: "json",
            as: "map",
          },
          {
            kind: "parallel",
            branches: {
              bugs: { kind: "agent", name: "reviewer", task: "b {map}" },
              clarity: { kind: "agent", name: "reviewer", task: "c {map}" },
              security: {
                kind: "sequence",
                steps: [
                  { kind: "agent", name: "explorer", task: "s {map}" },
                  { kind: "agent", name: "reviewer", task: "a {previous}" },
                ],
              },
            },
            reduce: { agent: "worker", task: "merge {branches}" },
          },
          {
            kind: "map",
            over: "{map.hotspots}",
            body: { kind: "agent", name: "worker", task: "fix {item}" },
          },
          {
            kind: "loop",
            max: 2,
            body: { kind: "agent", name: "reviewer", task: "verify" },
          },
        ],
      },
      (_agent, task) => (task === "map" ? '{"hotspots":["a","b"]}' : "ok"),
    );
    const [line] = formatRunWidget(run, run.createdAt);
    // Four top-level steps, not one glyph per structural agent.
    expect(line).toContain("◆⑃⇶↺");
    expect(line).not.toContain("bugs");
  });

  test("a running composite expands its children recursively", async () => {
    // Sequence → parallel → sequence: the deepest agent stays running, so
    // every running ancestor expands and the strip zooms into the spine.
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: [
          {
            kind: "parallel",
            branches: {
              x: { kind: "agent", name: "a", task: "t" },
              sec: {
                kind: "sequence",
                steps: [
                  { kind: "agent", name: "b", task: "t" },
                  { kind: "agent", name: "c", task: "t" },
                ],
              },
            },
          },
        ],
      },
      () => "ok",
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        // Keep the deepest agent and all of its ancestors running.
        return ![
          "$.steps[0].branches.sec.steps[1]",
          "$.steps[0].branches.sec",
          "$.steps[0]",
          "$",
        ].includes(event.instance);
      },
    );
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    expect(line).toContain(
      "<warning>⑃</><dim>⟨</><success>◆</><warning>≡</><dim>⟨</>" +
        "<success>◆</><warning>◆</><dim>⟩</><dim>⟩</>",
    );
  });

  test("a running switch expands only the chosen arm", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: [
          {
            kind: "agent",
            name: "gate",
            task: "inspect",
            output: "json",
            as: "gate",
          },
          {
            kind: "switch",
            on: "{gate}",
            cases: [
              {
                when: { eq: ["status", "findings"] },
                then: { kind: "agent", name: "fixer", task: "fix" },
              },
            ],
            else: { kind: "agent", name: "reporter", task: "report" },
          },
        ],
      },
      (agent) => (agent === "gate" ? '{"status": "findings"}' : "ok"),
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        return !["$.steps[1].cases[0].then", "$.steps[1]", "$"].includes(
          event.instance,
        );
      },
    );
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    // Gate done; the switch expands to exactly the running chosen arm.
    expect(line).toContain(
      "<success>◆</><warning>⎇</><dim>⟨</><warning>◆</><dim>⟩</>",
    );
  });

  test("a running map shows one glyph per item, capped with an ellipsis", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
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
      (agent) =>
        agent === "scout"
          ? JSON.stringify(Array.from({ length: 10 }, (_, i) => `f${i}`))
          : "ok",
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        // Items finish; the map node itself stays running.
        return event.instance !== "$.steps[1]" && event.instance !== "$";
      },
    );
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    // 10 items: 8 collapsed glyphs plus a dim ellipsis inside the brackets.
    expect(line).toContain(
      `<warning>⇶</><dim>⟨</>${"<success>◆</>".repeat(8)}<dim>…</><dim>⟩</>`,
    );
  });

  test("a running map reducer joins the item glyphs", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
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
            reduce: { agent: "worker", task: "merge {items}" },
          },
        ],
      },
      (agent) => (agent === "scout" ? '["a","b"]' : "ok"),
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        // Items finish; the reducer and the map itself stay running.
        return !["$.steps[1].reduce", "$.steps[1]", "$"].includes(
          event.instance,
        );
      },
    );
    const [line] = formatRunWidget(run, run.createdAt, tagged);
    // Without the reducer glyph the expansion would read all-green while
    // the map still runs; the yellow ⑂ names the unfinished work.
    expect(line).toContain(
      "<warning>⇶</><dim>⟨</><success>◆</><success>◆</><warning>⑂</><dim>⟩</>",
    );
  });

  test("wide flows keep one glyph per step without overflow", async () => {
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: Array.from({ length: 8 }, (_, i) => ({
          kind: "agent",
          name: `a${i}`,
          task: "t",
        })),
      },
      () => "ok",
    );
    const [line] = formatRunWidget(run, run.createdAt);
    expect(line).toContain("◆◆◆◆◆◆◆◆");
    expect(line).not.toContain("…+");
  });
});

describe("live activity", () => {
  const runningReduce = (event: RunEvent) => {
    if (event.type === "run_completed") return false;
    if (event.type !== "node_completed") return true;
    return !event.instance.endsWith(".reduce") && event.instance !== "$";
  };

  test("the current tool joins line 1 without a turn count", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok", runningReduce);
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressTool = "bash";
        node.progressUsage = {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 7,
        };
        node.lastProgressAt = run.createdAt;
      }
    }
    const [line1] = formatRunWidget(run, run.createdAt + 1000);
    // Turns summed across concurrent agents are not meaningful; only the
    // token volume and the active tool surface here.
    expect(line1).not.toContain("turn");
    expect(line1).toContain("bash");
  });

  test("a long silence replaces the excerpt with a stall hint", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok", runningReduce);
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressText = "still merging";
        node.lastProgressAt = run.createdAt;
      }
    }
    const [fresh] = formatRunWidget(run, run.createdAt + STALL_AFTER_MS - 1000);
    expect(fresh).toContain("still merging");
    const [stalled] = formatRunWidget(
      run,
      run.createdAt + STALL_AFTER_MS + 121_000,
    );
    expect(stalled).toContain("no output for");
    expect(stalled).not.toContain("still merging");
  });
});

describe("RunWidget suppression", () => {
  function harness() {
    const runs = new Map<string, RunView>();
    runs.set("a", {
      status: "running",
      header: { id: "a", source: { kind: "command" } },
    } as unknown as RunView);
    const widget = new RunWidget({ state: { runs } } as never);
    const shown: unknown[] = [];
    const ctx = {
      mode: "tui",
      ui: { setWidget: (_key: string, value: unknown) => shown.push(value) },
    } as never;
    widget.update(ctx);
    return { widget, shown, last: () => shown.at(-1) };
  }

  test("a live run renders the summary until it is suppressed", () => {
    const { widget, last } = harness();
    expect(typeof last()).toBe("function");

    widget.setSuppressed(true);
    expect(last()).toBeUndefined();

    widget.setSuppressed(false);
    expect(typeof last()).toBe("function");
    widget.dispose();
  });

  test("suppression is orthogonal to the enabled preference", () => {
    const { widget, last } = harness();
    // Summary explicitly disabled, then a panel opens and closes: the
    // preference must survive, so the summary stays hidden afterwards.
    expect(widget.toggleEnabled()).toBe(false);
    widget.setSuppressed(true);
    widget.setSuppressed(false);
    expect(widget.isEnabled()).toBe(false);
    expect(last()).toBeUndefined();
    widget.dispose();
  });

  test("redundant suppression toggles do not re-render", () => {
    const { widget, shown } = harness();
    widget.setSuppressed(true);
    const count = shown.length;
    widget.setSuppressed(true);
    expect(shown.length).toBe(count);
    widget.dispose();
  });
});

describe("RunWidget lifecycle", () => {
  test("disposal detaches the session context from late updates", () => {
    const runs = new Map<string, RunView>();
    runs.set("a", {
      status: "running",
      header: { id: "a", source: { kind: "command" } },
    } as unknown as RunView);
    const widget = new RunWidget({ state: { runs } } as never);
    const shown: unknown[] = [];
    let contextActive = true;
    const ctx = {
      get mode() {
        if (!contextActive) throw new Error("stale context");
        return "tui";
      },
      get ui() {
        if (!contextActive) throw new Error("stale context");
        return {
          setWidget: (_key: string, value: unknown) => shown.push(value),
        };
      },
    } as never;

    widget.update(ctx);
    const count = shown.length;
    widget.dispose();
    contextActive = false;

    // A queued animation tick or late run-state callback may still call update
    // after pi invalidates this extension's session context.
    expect(() => widget.update()).not.toThrow();
    expect(shown.length).toBe(count);
  });
});
