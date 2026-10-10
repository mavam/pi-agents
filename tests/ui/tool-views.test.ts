import { describe, expect, test } from "bun:test";
import { receipt, type ToolReceipt } from "../../src/agents/receipts.js";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
} from "../../src/agents/types.js";
import { PARENT_TOOL_VIEWS } from "../../src/ui/tool-views.js";

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

/** A result as Pi's transcript draws it. */
function draw(
  tool: string,
  details: unknown,
  { expanded = false, text = "" } = {},
): string[] {
  return (
    PARENT_TOOL_VIEWS[tool]
      ?.renderResult?.(
        { content: [{ type: "text", text }], details },
        { expanded, isPartial: false },
        // biome-ignore lint/suspicious/noExplicitAny: a plain test theme.
        plainTheme as any,
        // biome-ignore lint/suspicious/noExplicitAny: renderers read isError.
        { isError: false, state: {} } as any,
      )
      .render(80) ?? []
  );
}

const usage = { ...EMPTY_USAGE, input: 1_000 };
const done: ToolReceipt["agents"][number] = {
  name: "a",
  model: "luna",
  outcome: "answered",
  usage,
  body: "The answer.",
};
const busy: ToolReceipt["agents"][number] = {
  name: "b",
  model: "luna",
  outcome: "working",
};

describe("tool results", () => {
  test("a wait shows why it ended; status shows states without clocks", () => {
    const details = (wait?: ToolReceipt["wait"]) => ({
      receipt: receipt({ agents: [done, busy], ...(wait ? { wait } : {}) }),
    });
    expect(draw("agent_wait", details("timeout"))).toEqual([
      "● a · luna · 1.0k",
      "⊠ b · luna",
      "Timed out",
    ]);
    expect(draw("agent_wait", details("attention"))).toEqual([
      "● a · luna · 1.0k",
      "⊠ b · luna",
      "Stopped waiting for your message",
    ]);
    expect(draw("agent_status", details())).toEqual([
      "● a · luna · 1.0k",
      "◉ b · luna",
    ]);
    expect(draw("agent_status", { receipt: receipt() })).toEqual(["No agents"]);
    // Expanded, answers show below their agents.
    expect(draw("agent_wait", details("done"), { expanded: true })).toEqual([
      "● a · luna · 1.0k",
      "  The answer.",
      "◉ b · luna",
    ]);
  });

  test("results stored by earlier versions still draw, without live state", () => {
    const agent = (id: string, name: string, state: AgentInfo["state"]) =>
      ({
        id,
        name,
        task: name,
        cwd: "/repo",
        model: { provider: "openai", modelId: "luna" },
        state,
        closed: false,
        createdAt: 0,
        stateSince: 0,
        lastActivityAt: 0,
        usage,
        activity: { tool: "grep" },
        queued: true,
      }) satisfies AgentInfo;
    const agents = [agent("1", "map", "idle"), agent("2", "report", "working")];
    const graph: GraphInfo = {
      id: "10",
      name: "audit",
      policy: "allSettled",
      state: "working",
      closed: false,
      stopped: false,
      createdAt: 0,
      stateSince: 0,
      nodes: [
        { agentId: "1", name: "map", inputs: [], end: false },
        { agentId: "2", name: "report", inputs: ["1"], end: true },
      ],
      usage,
    };
    // What a call started.
    expect(
      draw("agent_spawn_graph", {
        at: 5_000,
        started: true,
        graphs: [graph],
        agents,
      }),
    ).toEqual([
      "audit · graph of 2",
      "├─ map · luna",
      "└─ report ← map · luna",
    ]);
    // A wait that timed out.
    expect(
      draw("agent_wait", {
        at: 5_000,
        agents: agents.slice(1),
        timedOut: ["report"],
      }),
    ).toEqual(["⊠ report · luna", "Timed out"]);
    // Details this version can't read show the result's text.
    expect(
      draw("agent_wait", { receipt: { version: 99 } }, { text: "x" }),
    ).toEqual(["x"]);
  });
});
