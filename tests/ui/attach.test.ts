import { describe, expect, test } from "bun:test";
import {
  openAgentPane,
  queuedTexts,
  restoredEditorText,
  withoutUserPrefix,
} from "../../src/ui/attach.js";

describe("attach view", () => {
  test("hides the user marker the agent sees", () => {
    expect(withoutUserPrefix("[user] hello")).toBe("hello");
    expect(withoutUserPrefix("review src")).toBe("review src");
  });

  test("restores queued messages, steering first, before the draft", () => {
    const queued = queuedTexts({
      items: [
        { id: 1, mode: "followUp", content: "[user] then tests" },
        { id: 2, mode: "steer", content: "[user] focus on errors" },
        { id: 3, mode: "write", entry: {} },
      ],
    } as never);
    expect(queued).toEqual(["focus on errors", "then tests"]);
    expect(restoredEditorText(queued, "draft")).toBe(
      "focus on errors\n\nthen tests\n\ndraft",
    );
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
