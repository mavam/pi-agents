import { describe, expect, test } from "bun:test";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
} from "../../src/agents/types.js";
import { formatFooterSummary } from "../../src/ui/footer.js";
import {
  formatAgentLine,
  formatElapsed,
  formatGraphLine,
  graphShape,
  runtime,
  sanitizeLine,
} from "../../src/ui/format.js";
import { panelCompare, panelOrder } from "../../src/ui/panel.js";
import {
  attachTarget,
  buildRows,
  connector,
  Disclosure,
  fold,
  hiddenNote,
} from "../../src/ui/rows.js";

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

function graph(overrides: Partial<GraphInfo>): GraphInfo {
  return {
    id: "10",
    name: "review",
    policy: "allSettled",
    state: "working",
    closed: false,
    stopped: false,
    createdAt: 0,
    stateSince: 0,
    nodes: [
      { agentId: "11", name: "api", inputs: [], end: false },
      { agentId: "12", name: "tests", inputs: [], end: false },
      { agentId: "13", name: "merge", inputs: ["11", "12"], end: true },
    ],
    usage: { ...EMPTY_USAGE },
    ...overrides,
  };
}

const answered = (agentId: string, name: string, inputs: string[] = []) => ({
  agentId,
  name,
  inputs,
  end: false,
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

  test("queued results show in the accent color with a note", () => {
    const color = (name: string, text: string) => `<${name}>${text}`;
    expect(
      formatAgentLine(agent({ state: "idle", queued: true }), 5_000, color),
    ).toBe("<accent>● reviewer<dim> · <dim>terra<dim> · <dim>result queued");
    expect(formatAgentLine(agent({ state: "idle" }), 5_000, color)).toBe(
      "<success>● reviewer<dim> · <dim>terra",
    );
    expect(
      formatGraphLine(
        graph({
          state: "idle",
          queued: true,
          nodes: [answered("11", "api"), answered("12", "tests")],
        }),
        0,
        color,
      ),
    ).toBe("<accent>● review<dim> · <dim>graph 2/2<dim> · <dim>result queued");
    // A failed graph keeps its glyph; the note still says it waits.
    expect(
      formatGraphLine(
        graph({
          state: "failed",
          queued: true,
          nodes: [
            answered("11", "api"),
            {
              agentId: "12",
              name: "tests",
              inputs: [],
              end: true,
              outcome: { kind: "failed", reason: "boom" },
            },
          ],
        }),
        0,
      ),
    ).toBe("✗ review · graph 2/2 · 1 failed · result queued");
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

  test("the clock stops once an agent or graph finishes", () => {
    const times = { createdAt: 1_000, stateSince: 61_000 };
    expect(runtime({ ...times, state: "working" }, 600_000)).toBe(599_000);
    expect(runtime({ ...times, state: "idle" }, 600_000)).toBe(60_000);
    expect(runtime({ ...times, state: "interrupted" }, 900_000)).toBe(60_000);
    expect(runtime({ ...times, state: "waiting" }, 600_000)).toBe(599_000);
    // The durable end wins over when this process saw the state change.
    expect(runtime({ ...times, state: "idle", endedAt: 31_000 }, 600_000)).toBe(
      30_000,
    );
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

  test("graph lines carry progress, elapsed time, usage, and failures", () => {
    expect(
      formatGraphLine(
        graph({
          nodes: [
            answered("11", "api"),
            { agentId: "12", name: "tests", inputs: [], end: true },
          ],
          usage: { ...EMPTY_USAGE, input: 31_500 },
        }),
        92_000,
      ),
    ).toBe("◉ review · graph 1/2 · 1m32s · 31.5k");
    expect(
      formatGraphLine(
        graph({
          state: "failed",
          nodes: [
            answered("11", "api"),
            {
              agentId: "12",
              name: "tests",
              inputs: [],
              end: false,
              outcome: { kind: "failed", reason: "boom" },
            },
            {
              agentId: "13",
              name: "merge",
              inputs: ["11", "12"],
              end: true,
              outcome: { kind: "skipped" },
            },
          ],
        }),
        92_000,
      ),
    ).toBe("✗ review · graph 3/3 · 1 failed, 1 skipped");
    expect(
      formatGraphLine(graph({ state: "interrupted", stopped: true }), 0),
    ).toBe("⊘ review · graph 0/3 · stopped");
    expect(graphShape(graph({}))).toBe("{api, tests} → merge");
  });

  test("waiting agents show their inputs", () => {
    expect(
      formatAgentLine(
        agent({ name: "merge", state: "waiting" }),
        0,
        undefined,
        ["api", "tests"],
      ),
    ).toBe("○ merge ← api, tests · terra");
  });

  test("rows draw a graph's agents as a tree and fold finished graphs", () => {
    const agents = [
      agent({ id: "11", name: "api", graph: "10", createdAt: 5 }),
      agent({ id: "12", name: "tests", graph: "10", createdAt: 5 }),
      agent({ id: "13", name: "merge", graph: "10", createdAt: 5 }),
      agent({ id: "1", name: "solo", state: "idle", createdAt: 9 }),
    ];
    const source = (info: GraphInfo) => ({
      agents,
      graphs: [info],
      agent: (id: string) => agents.find((each) => each.id === id),
    });
    const working = buildRows(
      source(graph({ createdAt: 5 })),
      panelCompare,
      () => true,
    );
    expect(working.map((row) => row.key)).toEqual([
      "graph:10",
      "agent:11",
      "agent:12",
      "agent:13",
      "agent:1",
    ]);
    expect(working.map(connector)).toEqual(["", "├─ ", "├─ ", "└─ ", ""]);
    const merge = working[3];
    expect(merge?.kind === "agent" && merge.inputs).toEqual(["api", "tests"]);
    const first = working[0];
    expect(first && attachTarget(first)).toBe("11");
    const folded = buildRows(
      source(graph({ state: "idle", createdAt: 5 })),
      panelCompare,
      (info) => info.state === "working",
    );
    expect(folded.map((row) => row.key)).toEqual(["agent:1", "graph:10"]);
    // Without its graph, a graph's agent stands alone.
    const alone = buildRows(
      { agents, graphs: [], agent: () => undefined },
      panelCompare,
      () => true,
    );
    expect(alone.map((row) => row.key)).toEqual([
      "agent:1",
      "agent:11",
      "agent:12",
      "agent:13",
    ]);
  });

  test("helpers draw under the agent that started them", () => {
    const agents = [
      agent({ id: "1", name: "lead", graph: "10", state: "working" }),
      agent({ id: "2", name: "other", graph: "10" }),
      agent({ id: "3", name: "lead.a", graph: "20" }),
      agent({ id: "4", name: "lead.b", graph: "20" }),
      agent({ id: "5", name: "solo", createdAt: 9 }),
      agent({ id: "6", name: "solo.x", graph: "30" }),
    ];
    const top = graph({
      id: "10",
      nodes: [
        { agentId: "1", name: "lead", inputs: [], end: true },
        { agentId: "2", name: "other", inputs: [], end: true },
      ],
    });
    const helpers = graph({
      id: "20",
      name: "lead.helpers",
      owner: "1",
      nodes: [
        { agentId: "3", name: "lead.a", inputs: [], end: false },
        { agentId: "4", name: "lead.b", inputs: ["3"], end: true },
      ],
    });
    const solo = graph({
      id: "30",
      name: "solo.helpers",
      owner: "5",
      createdAt: 9,
      nodes: [{ agentId: "6", name: "solo.x", inputs: [], end: true }],
    });
    const rows = buildRows(
      {
        agents,
        graphs: [top, helpers, solo],
        agent: (id) => agents.find((each) => each.id === id),
      },
      panelCompare,
      () => true,
    );
    expect(rows.map((row) => `${connector(row)}${row.key}`)).toEqual([
      "graph:10",
      "├─ agent:1",
      "│  └─ graph:20",
      "│     ├─ agent:3",
      "│     └─ agent:4",
      "└─ agent:2",
      "agent:5",
      "└─ graph:30",
      "   └─ agent:6",
    ]);
  });

  test("space folds graphs and helpers, from any row below them", () => {
    const agents = [
      agent({ id: "1", name: "lead", graph: "10", state: "working" }),
      agent({ id: "2", name: "other", graph: "10" }),
      agent({ id: "3", name: "lead.a", graph: "20" }),
      agent({ id: "4", name: "lead.b", graph: "20" }),
    ];
    const graphs = [
      graph({
        id: "10",
        nodes: [
          { agentId: "1", name: "lead", inputs: [], end: true },
          { agentId: "2", name: "other", inputs: [], end: true },
        ],
      }),
      graph({
        id: "20",
        name: "lead.helpers",
        owner: "1",
        nodes: [
          { agentId: "3", name: "lead.a", inputs: [], end: true },
          { agentId: "4", name: "lead.b", inputs: [], end: true },
        ],
      }),
    ];
    const disclosure = new Disclosure();
    const rows = () =>
      buildRows(
        {
          agents,
          graphs,
          agent: (id) => agents.find((each) => each.id === id),
        },
        panelCompare,
        () => true,
        disclosure,
      );
    const keys = () => rows().map((row) => row.key);
    const row = (key: string) => {
      const found = rows().find((each) => each.key === key);
      if (!found) throw new Error(`no row ${key}`);
      return found;
    };
    expect(row("graph:10").below).toBe(4);
    expect(row("agent:1").below).toBe(2);

    // Space on a helper folds the helpers' graph and selects it.
    expect(fold(row("agent:3"), disclosure)).toBe("graph:20");
    expect(keys()).toEqual(["graph:10", "agent:1", "graph:20", "agent:2"]);
    expect(hiddenNote(row("graph:20"))).toBe("2 hidden");

    // Space on a folded row unfolds it.
    expect(fold(row("graph:20"), disclosure)).toBe("graph:20");
    expect(keys()).toHaveLength(6);

    // An agent with helpers folds them; a graph folds everything below it.
    fold(row("agent:1"), disclosure);
    expect(keys()).toEqual(["graph:10", "agent:1", "agent:2"]);
    fold(row("graph:10"), disclosure);
    expect(keys()).toEqual(["graph:10"]);
    expect(hiddenNote(row("graph:10"))).toBe("4 hidden");

    // The user's choice wins over the default, also for finished graphs.
    const finished = buildRows(
      { agents, graphs, agent: (id) => agents.find((each) => each.id === id) },
      panelCompare,
      () => false,
      disclosure,
    );
    expect(finished.map((each) => each.key)).toEqual(["graph:10"]);
    fold(row("graph:10"), disclosure);
    expect(
      buildRows(
        {
          agents,
          graphs,
          agent: (id) => agents.find((each) => each.id === id),
        },
        panelCompare,
        () => false,
        disclosure,
      ).map((each) => each.key),
    ).toEqual(["graph:10", "agent:1", "agent:2"]);
  });

  test("helpers drop their agent's name below it", () => {
    const agents = [
      agent({ id: "1", name: "lead", state: "working" }),
      agent({ id: "3", name: "lead.a", graph: "20" }),
      agent({ id: "4", name: "lead.merge", graph: "20" }),
    ];
    const helpers = graph({
      id: "20",
      name: "lead.helpers",
      owner: "1",
      nodes: [
        { agentId: "3", name: "lead.a", inputs: [], end: false },
        { agentId: "4", name: "lead.merge", inputs: ["3"], end: true },
      ],
    });
    const labels = (shown: typeof agents) =>
      buildRows(
        {
          agents: shown,
          graphs: [helpers],
          agent: (id) => agents.find((each) => each.id === id),
        },
        panelCompare,
        () => true,
      ).map((row) =>
        row.kind === "agent" && row.inputs.length > 0
          ? `${row.label} ← ${row.inputs.join(", ")}`
          : row.label,
      );
    expect(labels(agents)).toEqual(["lead", "helpers", "a", "merge ← a"]);
    // Without its agent, the graph keeps the name that says whose it is.
    expect(labels(agents.slice(1))).toEqual(["lead.helpers", "a", "merge ← a"]);
    expect(
      formatAgentLine(
        agent({
          name: "lead",
          state: "working",
          lastActivityAt: 1_000,
          activity: {
            delegation: { graph: "lead.helpers", done: 1, total: 2 },
          },
        }),
        2_000,
      ),
    ).toBe("◉ lead · terra · 2s · delegating · helpers 1/2");
  });

  test("an agent that waits for helpers shows their progress", () => {
    expect(
      formatAgentLine(
        agent({
          state: "working",
          lastActivityAt: 1_000,
          stateSince: 0,
          activity: {
            delegation: { graph: "lead.helpers", done: 1, total: 3 },
          },
        }),
        2_000,
      ),
    ).toBe("◉ reviewer · terra · 2s · delegating · lead.helpers 1/3");
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
