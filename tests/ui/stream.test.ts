import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { MessageInfo } from "../../src/agents/types.js";
import { plainStyle } from "../../src/ui/messages.js";
import { messageStream, streamRow } from "../../src/ui/stream.js";

const alpha = { id: "1", name: "alpha" };
const beta = { id: "2", name: "beta" };
const gamma = { id: "3", name: "gamma" };
const at = new Date(2026, 9, 11, 12, 48, 30).getTime();

function message(
  id: string,
  from: typeof alpha,
  to: typeof alpha,
  text: string,
  offset: number,
): MessageInfo {
  return { id, from, to, text, sentAt: at + offset, status: "delivered" };
}

const messages = [
  message("1", alpha, gamma, "Offer two picnic activities", 0),
  message("2", beta, alpha, "Reserve the central lawn", 1_000),
  message("3", gamma, beta, "Serve wraps and fruit", 2_000),
];

describe("/messages", () => {
  test("a stream is newest first, filtered by text and names", () => {
    const ids = (query?: string) =>
      messageStream(messages, query).map((each) => each.id);
    expect(ids()).toEqual(["3", "2", "1"]);
    // Everything to or from an agent, by name, ignoring case.
    expect(ids("ALPHA")).toEqual(["2", "1"]);
    expect(ids("wraps")).toEqual(["3"]);
    expect(ids("beta → alpha")).toEqual(["2"]);
  });

  test("a message is one line, its text right after the names", () => {
    const long = message("4", alpha, beta, "one two three\nfour five", 0);
    const row = stripVTControlCharacters(streamRow(long, 30, plainStyle));
    expect(row).toBe("12:48:30 alpha → beta one two…");
  });
});
