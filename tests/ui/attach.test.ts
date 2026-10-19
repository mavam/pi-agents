import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
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
  wheelScrollBack,
} from "../../src/ui/attach.js";

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
