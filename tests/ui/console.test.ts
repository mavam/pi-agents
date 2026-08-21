import { describe, expect, test } from "bun:test";
import {
  AgentPane,
  formatPendingPromptLines,
  sanitizeLine,
  toolResultPayload,
} from "../../src/ui/console.js";

const ESC = "\u001b";
const BEL = "\u0007";

describe("sanitizeLine", () => {
  test("removes OSC sequences whole instead of stripping their terminator", () => {
    // pi wraps messages in OSC 133 zones; a half-stripped OSC makes the
    // terminal swallow everything after it.
    expect(sanitizeLine(`${ESC}]133;A${BEL}hello`)).toBe("hello");
    expect(sanitizeLine(`tail${ESC}]133;B${BEL}${ESC}]133;C${BEL}done`)).toBe(
      "taildone",
    );
    expect(sanitizeLine(`st${ESC}]0;title${ESC}\\rest`)).toBe("strest");
  });

  test("keeps SGR colors, expands tabs, drops other control bytes", () => {
    expect(sanitizeLine(`${ESC}[7mbadge${ESC}[27m`)).toBe(
      `${ESC}[7mbadge${ESC}[27m`,
    );
    expect(sanitizeLine("a\tb\rc")).toBe("a  bc");
  });

  test("strips terminal controls other than SGR", () => {
    expect(sanitizeLine(`before${ESC}[2Jafter`)).toBe("beforeafter");
    expect(sanitizeLine(`before${ESC}[Hafter`)).toBe("beforeafter");
    expect(sanitizeLine(`before${ESC}Ppayload${ESC}\\after`)).toBe(
      "beforeafter",
    );
    expect(sanitizeLine(`before${ESC}]unterminated`)).toBe("before");
  });
});

describe("toolResultPayload", () => {
  test("turns an interrupted tool into a final error before output arrives", () => {
    expect(
      toolResultPayload({
        key: "tool:1",
        kind: "tool",
        label: "sleep 10",
        status: "error",
        toolName: "bash",
        toolCallId: "call-1",
        args: { command: "sleep 10" },
        at: Date.now(),
      }),
    ).toEqual({ content: [], isError: true });
  });
});

describe("AgentPane", () => {
  test("omits the parent workflow overview above the editor", () => {
    const instance = "$.alpha";
    const label = "Dummy alpha-beta-gamma sleep workflow";
    const node = {
      instance,
      kind: "agent",
      status: "running",
      agent: "alpha",
      startedAt: Date.now(),
    };
    const run = {
      header: { label, cwd: process.cwd(), flow: { kind: "agent" } },
      nodes: new Map([[instance, node]]),
    };
    const manager = {
      state: { runs: new Map([["run-id", run]]) },
      liveHandle: () => ({ transcript: () => [], hold: () => () => {} }),
    };
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = { fg: (_name: string, text: string) => text };
    const keybindings = { matches: () => false };
    const pane = new AgentPane(
      tui as never,
      theme as never,
      keybindings as never,
      {
        manager: manager as never,
        runId: "run-id",
        instance,
        done() {},
      },
    );
    try {
      const rendered = pane.render(100).join("\n");
      // The run label remains only in the editor-border badge. It must not be
      // repeated as a workflow status line between transcript and editor.
      expect(rendered.match(new RegExp(label, "g"))).toHaveLength(1);
      expect(rendered).not.toContain("❖");
      expect(rendered).not.toContain("⏎ send");
    } finally {
      pane.dispose();
    }
  });
});

describe("formatPendingPromptLines", () => {
  const pending = Array.from({ length: 5 }, (_, index) => ({
    key: `user:${index}`,
    kind: "user" as const,
    text: `message ${index + 1}`,
    queued: true,
    at: index,
  }));

  test("fits pending prompts into the available row budget", () => {
    expect(formatPendingPromptLines(pending, 3)).toEqual([
      "↻ queued · message 1",
      "↻ queued · message 2",
      "… +3 more queued",
    ]);
    expect(formatPendingPromptLines(pending, 1)).toEqual([
      "↻ 5 queued messages",
    ]);
    expect(formatPendingPromptLines(pending, 0)).toEqual([]);
  });
});
