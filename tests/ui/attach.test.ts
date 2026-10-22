import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  Container,
  Spacer,
  Text,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  agentMessageInput,
  inputOrigin,
  userInput,
} from "../../src/agents/inputs.js";
import {
  displayedResult,
  liveScriptCalls,
  openAgentPane,
  queuedTexts,
  restoredEditorText,
  routeTranscriptMouse,
  wheelScrollBack,
  windowTranscript,
} from "../../src/ui/attach.js";
import { expandableCard } from "../../src/ui/expandable.js";

describe("attach view", () => {
  test("tells inputs apart by their entry", () => {
    const user = userInput("hello");
    expect(inputOrigin(user.entry, user.content)).toEqual({
      kind: "user",
      text: "hello",
    });
    // A user's text that looks like a message stays the user's.
    const quoted = userInput("[from api] done");
    expect(inputOrigin(quoted.entry, quoted.content)).toEqual({
      kind: "user",
      text: "[from api] done",
    });
    const message = agentMessageInput("api", "done");
    expect(inputOrigin(message.entry, message.content)).toEqual({
      kind: "message",
      from: "api",
      text: "done",
    });
    // A plain input is the parent's, whatever its text.
    const plain = { kind: "pi.user" };
    expect(inputOrigin(plain, "[from api] done")).toEqual({
      kind: "parent",
      text: "[from api] done",
    });
    expect(inputOrigin(plain, "review src")).toEqual({
      kind: "parent",
      text: "review src",
    });
  });

  test("shows a failed command's exit code as Pi does", () => {
    const result = {
      role: "toolResult",
      toolCallId: "1",
      toolName: "bash",
      content: [
        { type: "text", text: "out\n" },
        {
          type: "text",
          text: "<harness>\n[error] Command exited with code 3\n</harness>",
        },
      ],
      isError: true,
      timestamp: 0,
    } as ToolResultMessage;
    expect(displayedResult(result).content).toEqual([
      { type: "text", text: "out\n" },
      { type: "text", text: "\nCommand exited with code 3" },
    ]);
  });

  test("restores queued messages, steering first, before the draft", () => {
    const queued = queuedTexts({
      items: [
        { id: 1, mode: "followUp", ...userInput("then tests") },
        { id: 2, mode: "steer", ...userInput("focus on errors") },
        { id: 3, mode: "write", entry: {} },
        // Results of agents it spawned come again after an interrupt.
        {
          id: 4,
          mode: "followUp",
          content: "[results] scout answered",
          entry: { kind: "pi-agents.results", data: { groups: [] } },
        },
        { id: 5, mode: "steer", ...agentMessageInput("api", "done") },
      ],
    } as never);
    expect(queued).toEqual(["focus on errors", "then tests"]);
    expect(restoredEditorText(queued, "draft")).toBe(
      "focus on errors\n\nthen tests\n\ndraft",
    );
  });

  test("shows a running script's own calls from the live nested calls", () => {
    const slot = (callId: string, parentCallId: string, extra = {}) => ({
      callId,
      parentCallId,
      parentTaskId: 1,
      taskId: 2,
      name: "read",
      status: "running",
      arguments: { path: "a" },
      ...extra,
    });
    const live = {
      nestedTools: [
        slot("s/c1", "s", {
          status: "done",
          summary: { isError: true, durationMs: 5, error: "missing" },
        }),
        slot("s/c2", "s"),
        // A call of a nested call, and another script's call.
        slot("s/c2/c1", "s/c2"),
        slot("t/c1", "t"),
      ],
    };
    expect(liveScriptCalls(live as never, "s")).toEqual([
      {
        name: "read",
        args: '{"path":"a"}',
        status: "error",
        durationMs: 5,
        error: "missing",
      },
      { name: "read", args: '{"path":"a"}', status: "running" },
    ]);
  });

  test("scrolls back on wheel up and forward on wheel down, within bounds", () => {
    expect(wheelScrollBack(0, 10, -3)).toBe(3);
    expect(wheelScrollBack(3, 10, 2)).toBe(1);
    expect(wheelScrollBack(8, 10, -5)).toBe(10);
    expect(wheelScrollBack(1, 10, 3)).toBe(0);
  });

  describe("clicks in the transcript", () => {
    const click = (y: number): TuiMouseEvent => ({
      type: "click",
      button: "left",
      x: 2,
      y,
      screenX: 2,
      screenY: y + 10,
      width: 40,
      height: 20,
      shift: false,
      alt: false,
      ctrl: false,
    });

    /** A transcript of filler lines, a card of `cardLines` lines that a
     * click expands, and a blank line, as the attach view stacks them. */
    function transcript(cardLines: number) {
      const container = new Container();
      container.addChild(new Text(Array(6).fill("filler").join("\n"), 0, 0));
      container.addChild(
        expandableCard(
          (expanded) =>
            new Text(
              expanded
                ? "card\nwhole"
                : Array(cardLines).fill("card").join("\n"),
              0,
              0,
            ),
          () => false,
        ),
      );
      container.addChild(new Spacer(1));
      return container;
    }

    /** The pane's window over the transcript, below its separator. */
    function frame(container: Container, rows: number, scrollBack: number) {
      const lines = container.render(40);
      const shown = windowTranscript(lines, rows, scrollBack);
      return {
        shown,
        window: {
          top: 1,
          start: shown.start,
          rows: shown.lines.length,
          total: lines.length,
          indicator: shown.indicator,
        },
      };
    }

    test("reach the card on the row clicked, in a window cut at the start", () => {
      const container = transcript(2);
      // 8 lines without the trailing blank; 4 rows show the newest.
      const { shown, window } = frame(container, 4, 0);
      expect(shown.lines.map((line) => line.trim())).toEqual([
        "filler",
        "filler",
        "card",
        "card",
      ]);
      // The separator and rows above the card hit nothing that toggles.
      expect(
        routeTranscriptMouse(container, window, click(0), () => {}),
      ).toBeUndefined();
      expect(
        routeTranscriptMouse(container, window, click(2), () => {}),
      ).toBeUndefined();
      expect(
        routeTranscriptMouse(container, window, click(3), () => {}),
      ).toMatchObject({ handled: true });
      expect(container.render(40).join("\n")).toContain("whole");
      // Below the transcript: the status and the editor.
      expect(
        routeTranscriptMouse(container, window, click(5), () => {}),
      ).toBeUndefined();
    });

    test("skip the newer-lines note, whose click follows new output", () => {
      const container = transcript(4);
      const { shown, window } = frame(container, 4, 2);
      // 3 content rows ending 2 lines above the newest, then the note.
      expect(shown).toMatchObject({ start: 5, indicator: true, scrollBack: 2 });
      let followed = false;
      const follow = () => {
        followed = true;
      };
      expect(routeTranscriptMouse(container, window, click(4), follow)).toEqual(
        { handled: true },
      );
      expect(followed).toBe(true);
      expect(container.render(40).join("\n")).not.toContain("whole");
      // Row 2 shows line 6, the card's first line.
      routeTranscriptMouse(container, window, click(2), follow);
      expect(container.render(40).join("\n")).toContain("whole");
    });
  });

  describe("working loader", () => {
    function fake(custom: () => Promise<void>) {
      const calls: string[] = [];
      const ctx = {
        ui: {
          setWorkingVisible: (visible: boolean) =>
            calls.push(`visible:${visible}`),
          custom: async () => {
            calls.push("custom");
            await custom();
          },
        },
      };
      const service = { view: async () => ({}) };
      return {
        calls,
        run: () => openAgentPane(ctx as never, service as never, "a"),
      };
    }

    test("hides Pi's loader while attached and restores it after", async () => {
      const { calls, run } = fake(async () => {});
      await run();
      expect(calls).toEqual(["visible:false", "custom", "visible:true"]);
    });

    test("restores Pi's loader when the pane fails", async () => {
      const { calls, run } = fake(async () => {
        throw new Error("boom");
      });
      await expect(run()).rejects.toThrow("boom");
      expect(calls).toEqual(["visible:false", "custom", "visible:true"]);
    });
  });
});
