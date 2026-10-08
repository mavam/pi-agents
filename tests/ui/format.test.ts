import { describe, expect, test } from "bun:test";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GroupInfo,
} from "../../src/agents/types.js";
import { formatFooterSummary } from "../../src/ui/footer.js";
import {
  formatAgentLine,
  formatElapsed,
  formatGroupLine,
  sanitizeLine,
} from "../../src/ui/format.js";
import { panelCompare, panelOrder } from "../../src/ui/panel.js";
import { attachTarget, buildRows } from "../../src/ui/rows.js";

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "1",
    name: "reviewer",
    task: "review",
    cwd: "/repo",
    model: { provider: "openai", modelId: "terra" },
    state: "idle",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE },
    activity: {},
    ...overrides,
  };
}

function group(overrides: Partial<GroupInfo>): GroupInfo {
  return {
    id: "10",
    name: "review",
    policy: "allSettled",
    state: "working",
    closed: false,
    stopped: false,
    createdAt: 0,
    stateSince: 0,
    members: [
      { agentId: "11", name: "api" },
      { agentId: "12", name: "tests" },
    ],
    usage: { ...EMPTY_USAGE },
    ...overrides,
  };
}

const answered = (agentId: string, name: string) => ({
  agentId,
  name,
  outcome: {
    kind: "answered" as const,
    result: { agentId, name, entryId: 1, text: "ok", stopReason: "stop" },
  },
});

describe("formatting", () => {
  test("agent lines carry state, model, elapsed time, usage, and activity", () => {
    const line = formatAgentLine(
      agent({
        state: "working",
        profile: "explorer",
        usage: { ...EMPTY_USAGE, input: 15_000, output: 500, cost: 0.04 },
        activity: { tool: "grep" },
        stateSince: 0,
        lastActivityAt: 90_000,
      }),
      92_000,
    );
    expect(line).toBe(
      "◉ reviewer · explorer · terra · 1m32s · 15.5k · $0.040 · Using grep",
    );
  });

  test("settled agents show no elapsed time", () => {
    expect(formatAgentLine(agent({ state: "idle" }), 5_000)).toBe(
      "● reviewer · terra",
    );
  });

  test("silent working agents show a stall hint", () => {
    const line = formatAgentLine(
      agent({ state: "working", lastActivityAt: 0 }),
      120_000,
    );
    expect(line).toContain("no activity for 2m00s");
  });

  test("elapsed times scale", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(65_000)).toBe("1m05s");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
  });

  test("sanitizing keeps colors and drops controls", () => {
    expect(sanitizeLine("\u001b[31mred\u001b[0m\u001b[2Jx\ty")).toBe(
      "\u001b[31mred\u001b[0mx  y",
    );
  });

  test("panel order puts working agents first, newest first", () => {
    const ordered = panelOrder([
      agent({ id: "a", name: "a", state: "idle", createdAt: 3 }),
      agent({ id: "b", name: "b", state: "working", createdAt: 1 }),
      agent({ id: "c", name: "c", state: "working", createdAt: 2 }),
      agent({ id: "d", name: "d", state: "failed", createdAt: 0 }),
    ]);
    expect(ordered.map((info) => info.name)).toEqual(["c", "b", "d", "a"]);
  });

  test("group lines carry progress, elapsed time, usage, and failures", () => {
    expect(
      formatGroupLine(
        group({
          members: [answered("11", "api"), { agentId: "12", name: "tests" }],
          usage: { ...EMPTY_USAGE, input: 31_500 },
        }),
        92_000,
      ),
    ).toBe("◉ review · group 1/2 · 1m32s · 31.5k");
    expect(
      formatGroupLine(
        group({
          state: "failed",
          members: [
            answered("11", "api"),
            {
              agentId: "12",
              name: "tests",
              outcome: { kind: "failed", reason: "boom" },
            },
          ],
        }),
        92_000,
      ),
    ).toBe("✗ review · group 2/2 · 1 failed");
    expect(
      formatGroupLine(group({ state: "interrupted", stopped: true }), 0),
    ).toBe("⊘ review · group 0/2 · stopped");
  });

  test("rows nest a group's agents and fold finished groups", () => {
    const agents = [
      agent({ id: "11", name: "api", group: "10", createdAt: 5 }),
      agent({ id: "12", name: "tests", group: "10", createdAt: 5 }),
      agent({ id: "1", name: "solo", state: "idle", createdAt: 9 }),
    ];
    const source = (info: GroupInfo) => ({
      agents,
      groups: [info],
      agent: (id: string) => agents.find((each) => each.id === id),
    });
    const working = buildRows(
      source(group({ createdAt: 5 })),
      panelCompare,
      () => true,
    );
    expect(working.map((row) => row.key)).toEqual([
      "group:10",
      "agent:11",
      "agent:12",
      "agent:1",
    ]);
    const first = working[0];
    expect(first && attachTarget(first)).toBe("11");
    const folded = buildRows(
      source(group({ state: "idle", createdAt: 5 })),
      panelCompare,
      (info) => info.state === "working",
    );
    expect(folded.map((row) => row.key)).toEqual(["agent:1", "group:10"]);
    // Without its group, a group agent stands alone.
    const alone = buildRows(
      { agents, groups: [], agent: () => undefined },
      panelCompare,
      () => true,
    );
    expect(alone.map((row) => row.key)).toEqual([
      "agent:1",
      "agent:11",
      "agent:12",
    ]);
  });

  test("footer counts states", () => {
    expect(formatFooterSummary([])).toBe("");
    expect(
      formatFooterSummary([
        agent({ state: "working" }),
        agent({ state: "working" }),
        agent({ state: "idle" }),
      ]),
    ).toBe("2◉ 1●");
  });
});
