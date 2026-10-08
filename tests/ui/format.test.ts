import { describe, expect, test } from "bun:test";
import { type AgentInfo, EMPTY_USAGE } from "../../src/agents/types.js";
import { formatFooterSummary } from "../../src/ui/footer.js";
import {
  formatAgentLine,
  formatElapsed,
  sanitizeLine,
} from "../../src/ui/format.js";
import { panelOrder } from "../../src/ui/panel.js";

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
