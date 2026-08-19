import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { type RunView, rebuildRunState } from "../../src/run/state.js";
import { RunPanel } from "../../src/ui/panel.js";
import {
  type Colorize,
  formatRunWidget,
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
  handler: (agent: string | undefined, task: string) => unknown,
  keep: (event: RunEvent) => boolean = () => true,
): Promise<RunView> {
  const flow = validateFlow(raw);
  const events: RunEvent[] = [];
  await executeFlow({
    runId: "w1",
    flow,
    label: "review",
    budgets: { maxAgents: 200 },
    runAgent: async (call) => ({ value: handler(call.agent, call.task) }),
    emit: (event) => events.push(event),
  });
  const run = rebuildRunState(events.filter(keep)).runs.get("w1");
  if (!run) throw new Error("missing run");
  return run;
}

describe("formatRunWidget", () => {
  test("completed run is one line with its agent count and an all-green strip", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const lines = formatRunWidget(run, run.createdAt + 92_000, tagged);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toStartWith("<muted>❖</> review");
    expect(line).toContain("<success>✦</>3/3");
    expect(line).not.toContain("<muted>❖</> <success>✦</>");
    expect(line).not.toContain("%");
    expect(line).toContain("1m32s");
    // Two agent branches plus the reducer, all completed.
    expect(line).toContain("<success>✦</><success>✦</><success>⑂</>");
    // Nothing is running, so nothing expands.
    expect(line).not.toContain("⟨");
  });

  test("mid-run shows completed and total agents with a running glyph", async () => {
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
    expect(line).toContain("<success>✦</>2/3");
    // Finished branches are green; the running reducer is the warning glyph.
    expect(line).toContain("<success>✦</><success>✦</><warning>⑂</>");
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
    expect(line).toContain("<success>✦</>0/3");
    expect(line).toContain("<dim>✦</><dim>✦</><dim>⑂</>");
  });

  test("a single-agent counter keeps pending and running status colors", async () => {
    const flow = { kind: "agent", name: "reviewer", task: "review" };
    const pending = await recordedRun(
      flow,
      () => "ok",
      (event) => event.type === "run_created",
    );
    const [pendingLine] = formatRunWidget(pending, pending.createdAt, tagged);
    expect(pendingLine).toContain("<dim>✦</>0/1");
    expect(pendingLine.match(/<dim>✦<\/>/g)).toHaveLength(1);

    const running = await recordedRun(
      flow,
      () => "ok",
      (event) =>
        event.type !== "node_completed" && event.type !== "run_completed",
    );
    const [runningLine] = formatRunWidget(
      running,
      running.createdAt + 8_000,
      tagged,
    );
    expect(runningLine).toContain("<warning>✦</>0/1");
    expect(runningLine.match(/<warning>✦<\/>/g)).toHaveLength(1);
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
            as: "files",
          },
          {
            kind: "map",
            over: "{files}",
            body: { kind: "agent", name: "reviewer", task: "review {item}" },
          },
        ],
      },
      (agent) => (agent === "scout" ? ["a", "b", "c"] : "ok"),
    );
    const [line] = formatRunWidget(run, run.createdAt + 1000);
    expect(line).toContain("✦⇶");
    // 1 scout + 3 map items = 4 agents total.
    expect(widgetProgress(run)).toEqual({ done: 4, total: 4 });
    expect(line).toContain("✦4/4");
  });

  test("switch totals use the smallest arm and self-correct as instances appear", async () => {
    const SWITCH_FLOW = {
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "gate",
          task: "inspect",
          json: {
            type: ["null", "boolean", "number", "string", "array", "object"],
          },
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
      (agent) => (agent === "gate" ? { status: "findings" } : "ok"),
      (event) => event.type === "run_created",
    );
    expect(widgetProgress(pending)).toEqual({ done: 0, total: 2 });
    // The larger arm ran: the total grows with the real instances while the
    // min-arm estimate avoids leaving a finished run with an inflated total.
    const run = await recordedRun(SWITCH_FLOW, (agent) =>
      agent === "gate" ? { status: "findings" } : "ok",
    );
    expect(widgetProgress(run)).toEqual({ done: 3, total: 3 });
    const [line] = formatRunWidget(run, run.createdAt);
    expect(line).toContain("✦3/3");
    expect(line).toContain("✦⎇");
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
            as: "scout",
          },
          { kind: "value", value: { seen: "{scout.count}" } },
        ],
      },
      () => ({ count: 3 }),
    );
    expect(widgetProgress(run)).toEqual({ done: 1, total: 1 });
    const [line] = formatRunWidget(run, run.createdAt);
    expect(line).toContain("✦1/1");
    expect(line).toContain("✦≔");
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
    expect(line).toContain("<success>✦</><error>✗</>");
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

  test("the active agent's reasoning summary joins line 1", async () => {
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
        node.progressSummary = "Merging findings into one prioritized list";
        node.progressSummaryAt = run.createdAt + 1000;
        node.progressTool = "bash";
        node.progressText = "assistant output fallback";
        node.lastProgressAt = run.createdAt;
      }
    }
    const [line1] = formatRunWidget(run, run.createdAt + 1000);
    expect(line1).toContain("· Merging findings into one prioritized list");
    expect(line1).not.toContain("Using bash");
    expect(line1).not.toContain("assistant output fallback");
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
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
      (_agent, task) => (task === "map" ? { hotspots: ["a", "b"] } : "ok"),
    );
    const [line] = formatRunWidget(run, run.createdAt);
    // Four top-level steps, not one glyph per structural agent.
    expect(line).toContain("✦⑃⇶↺");
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
      "<warning>⑃</><dim>⟨</><success>✦</><warning>≡</><dim>⟨</>" +
        "<success>✦</><warning>✦</><dim>⟩</><dim>⟩</>",
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
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
      (agent) => (agent === "gate" ? { status: "findings" } : "ok"),
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
      "<success>✦</><warning>⎇</><dim>⟨</><warning>✦</><dim>⟩</>",
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
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
          ? Array.from({ length: 10 }, (_, i) => `f${i}`)
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
      `<warning>⇶</><dim>⟨</>${"<success>✦</>".repeat(8)}<dim>…</><dim>⟩</>`,
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
            json: {
              type: ["null", "boolean", "number", "string", "array", "object"],
            },
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
      (agent) => (agent === "scout" ? ["a", "b"] : "ok"),
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
      "<warning>⇶</><dim>⟨</><success>✦</><success>✦</><warning>⑂</><dim>⟩</>",
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
    expect(line).toContain("✦✦✦✦✦✦✦✦");
    expect(line).not.toContain("…+");
  });
});

describe("formatRunWidget width budgeting", () => {
  const longLabel = "a-very-long-and-descriptive-workflow-label";

  async function longLabelRun(): Promise<RunView> {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    run.header.label = longLabel;
    return run;
  }

  async function threeDigitRun(): Promise<RunView> {
    const run = await recordedRun(
      {
        kind: "sequence",
        steps: [
          {
            kind: "sequence",
            steps: Array.from({ length: 50 }, () => ({
              kind: "agent",
              name: "ok",
              task: "work",
            })),
          },
          { kind: "agent", name: "fail", task: "stop" },
          {
            kind: "sequence",
            steps: Array.from({ length: 50 }, () => ({
              kind: "agent",
              name: "pending",
              task: "work",
            })),
          },
        ],
      },
      (agent) => {
        if (agent === "fail") throw new Error("stop");
        return "ok";
      },
    );
    run.header.label = longLabel;
    return run;
  }

  test("wide terminals show useful details without the run id", async () => {
    const run = await longLabelRun();
    run.header.id = "6b88f374-599d-4bed-98da-a65de84c20b5";
    const [line] = formatRunWidget(run, run.createdAt + 92_000, undefined, 200);
    expect(line).toContain(longLabel);
    expect(line).not.toContain("6b88f374");
    expect(line).toContain("1m32s");
    expect(line).toContain("✦✦⑂");
  });

  test("the glyph strip survives narrow widths", async () => {
    const run = await longLabelRun();
    for (const width of [40, 60, 80]) {
      const [line] = formatRunWidget(
        run,
        run.createdAt + 92_000,
        undefined,
        width,
      );
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).toContain("✦✦⑂");
    }
  });

  test("meta drops by usefulness: tokens, then elapsed", async () => {
    const run = await longLabelRun();
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
    const at = (width: number) =>
      formatRunWidget(run, run.createdAt + 92_000, undefined, width)[0];
    // Roomy enough for elapsed and tokens.
    const mid = at(50);
    expect(mid).toContain("4.5k");
    expect(mid).toContain("1m32s");
    // Tighter: tokens go next, elapsed is kept longest.
    const tight = at(36);
    expect(tight).not.toContain("4.5k");
    expect(tight).toContain("1m32s");
    // Tightest: all meta gone, label at its floor, strip intact.
    const minimal = at(23);
    expect(minimal).not.toContain("1m32s");
    // truncateToWidth may emit a style reset before the ellipsis.
    expect(minimal.replaceAll("\u001b[0m", "")).toContain("a-very-…");
    expect(minimal).toContain("✦✦⑂");
  });

  test("three-digit counts can shrink the label below its preferred floor", async () => {
    const run = await threeDigitRun();
    expect(widgetProgress(run)).toEqual({ done: 50, total: 101 });

    const [line] = formatRunWidget(run, run.createdAt, undefined, 23);
    expect(visibleWidth(line)).toBeLessThanOrEqual(23);
    expect(line).toContain("✦50/101");
    expect(line).toEndWith(" · ≡✗≡");

    // With no room for a label, retain the counter and status strip. If even
    // those cannot coexist, prefer the status strip over right truncation.
    expect(formatRunWidget(run, run.createdAt, undefined, 13)[0]).toBe(
      "✦50/101 · ≡✗≡",
    );
    expect(formatRunWidget(run, run.createdAt, undefined, 12)[0]).toBe("≡✗≡");
  });

  test("long labels shrink with an ellipsis but keep a readable floor", async () => {
    const run = await longLabelRun();
    const [line] = formatRunWidget(run, run.createdAt + 92_000, undefined, 50);
    expect(line).not.toContain(longLabel);
    expect(line).toContain("…");
    expect(line).toMatch(/a-very-/);
  });
});

describe("live activity", () => {
  const runningReduce = (event: RunEvent) => {
    if (event.type === "run_completed") return false;
    if (event.type !== "node_completed") return true;
    return !event.instance.endsWith(".reduce") && event.instance !== "$";
  };

  test("falls back to the active tool without showing turn counts", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok", runningReduce);
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressSummary = "Earlier reasoning";
        node.progressSummaryAt = run.createdAt;
        node.progressTool = "bash";
        node.progressText = "assistant output";
        node.progressUsage = {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 7,
        };
        node.lastProgressAt = run.createdAt + 1;
      }
    }
    const [line] = formatRunWidget(run, run.createdAt + 1000);
    expect(line).toContain("· Using bash");
    expect(line).not.toContain("turn");
    expect(line).not.toContain("assistant output");
    expect(line).toContain("✦✦⑂");
  });

  test("leaves activity blank without a summary or active tool", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok", runningReduce);
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressText = "assistant output";
        node.lastProgressAt = run.createdAt;
      }
    }
    const [line] = formatRunWidget(run, run.createdAt + 1000);
    expect(line).not.toContain("assistant output");
    expect(line).not.toContain("Using");
  });

  test("a long silence replaces the excerpt with an activity warning", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok", runningReduce);
    for (const node of run.nodes.values()) {
      if (node.status === "running" && node.kind === "reduce") {
        node.progressSummary = "still merging";
        node.lastProgressAt = run.createdAt;
      }
    }
    const [fresh] = formatRunWidget(run, run.createdAt + STALL_AFTER_MS - 1000);
    expect(fresh).toContain("still merging");
    const [stalled] = formatRunWidget(
      run,
      run.createdAt + STALL_AFTER_MS + 121_000,
    );
    expect(stalled).toContain("no activity for");
    expect(stalled).not.toContain("still merging");
  });
});

describe("RunPanel suppression", () => {
  function harness() {
    const runs = new Map<string, RunView>();
    runs.set("a", {
      status: "running",
      header: { id: "a", source: { kind: "command" } },
      nodes: new Map(),
    } as unknown as RunView);
    const widget = new RunPanel({ state: { runs } } as never);
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

describe("RunPanel lifecycle", () => {
  test("holds every workflow activity while coalescing newer ones", async () => {
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) => {
        if (event.type === "run_completed") return false;
        if (event.type !== "node_completed") return true;
        return !event.instance.endsWith(".reduce") && event.instance !== "$";
      },
    );
    const node = [...run.nodes.values()].find(
      (candidate) =>
        candidate.status === "running" && candidate.kind === "reduce",
    );
    if (!node) throw new Error("missing running reducer");
    let now = run.createdAt;
    node.progressSummary = "First headline";
    node.progressSummaryAt = now;
    node.lastProgressAt = now;
    const widget = new RunPanel(
      { state: { runs: new Map([[run.header.id, run]]) } } as never,
      () => now,
    );
    const shown: unknown[] = [];
    const ctx = {
      mode: "tui",
      ui: { setWidget: (_key: string, value: unknown) => shown.push(value) },
    } as never;
    const renderLast = () => {
      const factory = shown.at(-1) as (
        tui: unknown,
        theme: { fg: (color: string, text: string) => string },
      ) => { render: (width: number) => string[] };
      return factory({}, { fg: (_color, text) => text })
        .render(200)
        .join("\n");
    };

    widget.update(ctx);
    expect(renderLast()).toContain("First headline");
    now += 100;
    node.progressSummary = "Skipped headline";
    node.progressSummaryAt = now;
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("First headline");
    now += 100;
    node.progressSummary = "Latest headline";
    node.progressSummaryAt = now;
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("First headline");
    now = run.createdAt + 2_999;
    widget.update();
    expect(renderLast()).toContain("First headline");
    now = run.createdAt + 3_000;
    widget.update();
    expect(renderLast()).toContain("Latest headline");
    expect(renderLast()).not.toContain("Skipped headline");

    now += 5_000;
    node.progressTool = "bash";
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("Using bash");

    now += 100;
    node.progressTool = undefined;
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("Using bash");
    now += 100;
    node.progressTool = "read";
    node.lastProgressAt = now;
    widget.update();
    now += 100;
    node.progressTool = undefined;
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("Using bash");
    now = run.createdAt + 10_999;
    widget.update();
    expect(renderLast()).toContain("Using bash");
    now = run.createdAt + 11_000;
    widget.update();
    expect(renderLast()).toContain("Using read");

    now += 100;
    node.progressTool = "bash";
    node.lastProgressAt = now;
    widget.update();
    now += 100;
    node.progressTool = "read";
    node.lastProgressAt = now;
    widget.update();
    node.progressTool = undefined;
    now = run.createdAt + 14_000;
    node.lastProgressAt = now;
    widget.update();
    expect(renderLast()).toContain("Using read");
    expect(renderLast()).not.toContain("Using bash");
    widget.dispose();
  });

  test("disposal detaches the session context from late updates", () => {
    const runs = new Map<string, RunView>();
    runs.set("a", {
      status: "running",
      header: { id: "a", source: { kind: "command" } },
      nodes: new Map(),
    } as unknown as RunView);
    const widget = new RunPanel({ state: { runs } } as never);
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
