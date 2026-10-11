import { describe, expect, test } from "bun:test";
import type { MessageInfo } from "../../src/agents/types.js";
import { buildThreads, threadPair } from "../../src/ui/threads.js";

const agents = {
  scout: { id: "1", name: "scout" },
  notes: { id: "2", name: "notes" },
  docs: { id: "3", name: "docs" },
};

function message(
  from: keyof typeof agents,
  to: keyof typeof agents,
  sentAt: number,
): MessageInfo {
  return {
    id: `m${sentAt}`,
    from: agents[from],
    to: agents[to],
    text: `${from} to ${to}`,
    sentAt,
    status: "delivered",
  };
}

describe("threads", () => {
  test("a thread is a pair's exchange in both directions, latest first", () => {
    const messages = [
      message("scout", "notes", 1),
      message("docs", "notes", 2),
      message("notes", "scout", 3),
    ];
    const threads = buildThreads(messages);
    expect(threads.map((thread) => threadPair(thread))).toEqual([
      "scout ⇄ notes",
      "docs ⇄ notes",
    ]);
    expect(threads[0]?.messages.map((each) => each.sentAt)).toEqual([1, 3]);
    // One agent's threads, named from its side.
    expect(
      buildThreads(messages, "2").map((thread) => threadPair(thread, "2")),
    ).toEqual(["notes ⇄ scout", "notes ⇄ docs"]);
  });
});
