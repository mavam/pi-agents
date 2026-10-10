import { describe, expect, test } from "bun:test";
import type {
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { callKey } from "../../src/pi/calls.js";

/** A session of a line of entries; the last is the leaf. */
function session(entries: SessionEntry[]): ExtensionContext {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    sessionManager: {
      getLeafEntry: () => entries.at(-1),
      getEntry: (id: string) => byId.get(id),
    },
  } as unknown as ExtensionContext;
}

let count = 0;

function entry(
  message: SessionMessageEntry["message"],
  parent: SessionEntry | undefined,
): SessionEntry {
  return {
    type: "message",
    id: `e${++count}`,
    parentId: parent?.id ?? null,
    timestamp: new Date().toISOString(),
    message,
  };
}

function assistant(ids: string[], parent?: SessionEntry): SessionEntry {
  return entry(
    {
      role: "assistant",
      content: ids.map((id) => ({
        type: "toolCall" as const,
        id,
        name: "agent_spawn",
        arguments: {},
      })),
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    parent,
  );
}

function toolResult(id: string, parent: SessionEntry): SessionEntry {
  return entry(
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "agent_spawn",
      content: [],
      isError: false,
      timestamp: Date.now(),
    },
    parent,
  );
}

describe("call keys", () => {
  test("qualify IDs by the message that issued the call", () => {
    // A provider that numbers calls per message issues call_0 twice.
    const first = assistant(["call_0"]);
    const result = toolResult("call_0", first);
    const second = assistant(["call_0"], result);
    expect(callKey(session([first]), "call_0")).toBe(`${first.id}/call_0`);
    expect(callKey(session([first, result, second]), "call_0")).toBe(
      `${second.id}/call_0`,
    );
  });

  test("nested calls belong to the message of their caller", () => {
    const issuing = assistant(["toolu_a", "toolu_b"]);
    expect(callKey(session([issuing]), "toolu_b/2")).toBe(
      `${issuing.id}/toolu_b/2`,
    );
  });

  test("fall back to the ID without the message", () => {
    expect(callKey(session([]), "toolu_x")).toBe("toolu_x");
    expect(callKey({} as ExtensionContext, "toolu_x")).toBe("toolu_x");
    expect(callKey(session([]), "")).toBeUndefined();
  });
});
