import { describe, expect, test } from "bun:test";
import {
  AgentPane,
  AgentTranscriptView,
  formatPendingPromptLines,
  restoredEditorText,
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

describe("AgentTranscriptView", () => {
  test("renders lifecycle notices flush-left with neutral dim styling", () => {
    const colors: string[] = [];
    const view = new AgentTranscriptView(
      { requestRender() {} } as never,
      process.cwd(),
      (name, text) => {
        colors.push(name);
        return text;
      },
    );
    try {
      const now = Date.now();
      const lines = view.render(
        [
          {
            key: "notice:1",
            kind: "notice",
            notice: "interrupted",
            text: "Interrupted: restored 1 queued message to editor",
            at: now,
          },
          {
            key: "notice:2",
            kind: "notice",
            notice: "submission-deferred",
            text: "Submission deferred: detach to finish",
            at: now,
          },
          {
            key: "notice:3",
            kind: "notice",
            notice: "result-submitted",
            text: "Result submitted: Finished.",
            at: now,
          },
          {
            key: "notice:4",
            kind: "notice",
            notice: "detached",
            text: "Detached: finishing assignment",
            at: now,
          },
        ],
        80,
        4,
      );
      expect(lines.map((line) => line.trimEnd())).toEqual([
        "⊘ Interrupted: restored 1 queued message to editor",
        "○ Submission deferred: detach to finish",
        "● Result submitted: Finished.",
        "← Detached: finishing assignment",
      ]);
      expect(colors).toEqual(["dim", "dim", "dim", "dim"]);
    } finally {
      view.dispose();
    }
  });
});

describe("restoredEditorText", () => {
  test("prepends queued messages to the current draft", () => {
    expect(restoredEditorText(["first", "second\nline"], "draft")).toBe(
      "first\n\nsecond\nline\n\ndraft",
    );
    expect(restoredEditorText(["first"], "   ")).toBe("first");
    expect(restoredEditorText([], "draft")).toBe("draft");
  });
});

describe("AgentPane", () => {
  test("restores queued prompts after an interrupt", async () => {
    const instance = "$.alpha";
    const node = {
      instance,
      kind: "agent",
      status: "running",
      startedAt: Date.now(),
    };
    let interrupts = 0;
    const handle = {
      transcript: () => [],
      hold: () => () => {},
      interrupt: async () => {
        interrupts += 1;
        return ["first queued", "second queued"];
      },
    };
    const manager = {
      state: {
        runs: new Map([
          [
            "run-id",
            {
              header: { cwd: process.cwd(), flow: { kind: "agent" } },
              nodes: new Map([[instance, node]]),
            },
          ],
        ]),
      },
      liveHandle: () => handle,
    };
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = {
      fg: (_name: string, text: string) => text,
      bg: (_name: string, text: string) => text,
    };
    const pane = new AgentPane(
      tui as never,
      theme as never,
      { matches: () => false } as never,
      {
        manager: manager as never,
        runId: "run-id",
        instance,
        done() {},
      },
    );
    try {
      const internals = pane as unknown as {
        editor: { getText(): string; setText(text: string): void };
        interrupt(): void;
      };
      internals.editor.setText("current draft");
      internals.interrupt();
      await Promise.resolve();
      await Promise.resolve();
      expect(internals.editor.getText()).toBe(
        "first queued\n\nsecond queued\n\ncurrent draft",
      );
      expect(interrupts).toBe(1);
    } finally {
      pane.dispose();
    }
  });

  test("omits the parent workflow overview above the editor", () => {
    const instance = "$.alpha";
    const label = "Dummy alpha-beta-gamma sleep workflow";
    const node = {
      instance,
      kind: "agent",
      status: "running",
      profile: "alpha",
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
    const foregrounds: string[] = [];
    const backgrounds: string[] = [];
    const theme = {
      fg: (name: string, text: string) => {
        foregrounds.push(name);
        return text;
      },
      bg: (name: string, text: string) => {
        backgrounds.push(name);
        return text;
      },
    };
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
      expect(foregrounds).toContain("userMessageText");
      expect(backgrounds).toContain("userMessageBg");
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
      "↻ Queued: message 1",
      "↻ Queued: message 2",
      "… 3 more",
    ]);
    expect(formatPendingPromptLines(pending, 1)).toEqual([
      "↻ Queued: 5 messages",
    ]);
    expect(formatPendingPromptLines(pending, 0)).toEqual([]);
  });
});
