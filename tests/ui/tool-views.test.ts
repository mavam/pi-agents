import { describe, expect, test } from "bun:test";
import { receipt, type ToolReceipt } from "../../src/agents/receipts.js";
import { EMPTY_USAGE } from "../../src/agents/types.js";
import { PARENT_TOOL_VIEWS } from "../../src/ui/tool-views.js";

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

/** A result as Pi's transcript draws it. */
function draw(
  tool: string,
  details: unknown,
  { expanded = false, text = "", isPartial = false } = {},
): string[] {
  return (
    PARENT_TOOL_VIEWS[tool]
      ?.renderResult?.(
        { content: [{ type: "text", text }], details },
        { expanded, isPartial },
        // biome-ignore lint/suspicious/noExplicitAny: a plain test theme.
        plainTheme as any,
        // biome-ignore lint/suspicious/noExplicitAny: renderers read isError.
        { isError: false, state: {} } as any,
      )
      .render(80)
      // Results indent under their call; the lines compare without it.
      .map((line) => line.replace(/^ {2}/, "")) ?? []
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
      "● a luna 1.0k",
      "⊠ b luna",
      "Timed out",
    ]);
    expect(draw("agent_wait", details("attention"))).toEqual([
      "● a luna 1.0k",
      "⊠ b luna",
      "Stopped waiting for your message",
    ]);
    expect(draw("agent_status", details())).toEqual([
      "● a luna 1.0k",
      "◉ b luna",
    ]);
    expect(draw("agent_status", { receipt: receipt() })).toEqual(["No agents"]);
    // Expanded, answers show below their agents.
    expect(draw("agent_wait", details("done"), { expanded: true })).toEqual([
      "● a luna 1.0k",
      "  The answer.",
      "◉ b luna",
    ]);
  });

  test("a running wait says that a message stops it", () => {
    const running = { receipt: receipt({ agents: [busy] }) };
    expect(draw("agent_wait", running, { isPartial: true })).toEqual([
      "◉ b luna",
      "Send a message to stop waiting; the agents keep working.",
    ]);
    expect(draw("agent_wait", running)).toEqual(["◉ b luna"]);
  });

  test("unrecognized receipts show the result text", () => {
    // Details this version can't read show the result's text.
    expect(
      draw("agent_wait", { receipt: { version: 99 } }, { text: "x" }),
    ).toEqual(["x"]);
  });
});
