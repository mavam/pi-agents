import { describe, expect, test } from "bun:test";
import {
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
});
