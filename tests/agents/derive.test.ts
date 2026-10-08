import { describe, expect, test } from "bun:test";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import {
  activityOf,
  deriveState,
  latestHeadline,
  outcomeOf,
  resultOf,
  summarizeUsage,
} from "../../src/agents/derive.js";

function assistant(
  id: number,
  text: string,
  stopReason = "stop",
  extra: Record<string, unknown> = {},
): EntryRecord {
  return {
    id,
    conversationId: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        timestamp: 42,
        ...extra,
      },
    ],
  } as unknown as EntryRecord;
}

describe("deriveState", () => {
  test("a run means working", () => {
    expect(
      deriveState(
        { run: { taskId: 1, inputs: [] } } as unknown as LiveState,
        undefined,
      ),
    ).toBe("working");
  });
  test("settlements and stop reasons decide settled states", () => {
    const answered = resultOf(assistant(3, "ok"), "1", "a");
    expect(deriveState({}, answered)).toBe("idle");
    expect(deriveState({}, answered, "interrupted")).toBe("interrupted");
    expect(deriveState({}, answered, "failed")).toBe("failed");
    expect(deriveState({}, resultOf(assistant(4, "", "error"), "1", "a"))).toBe(
      "failed",
    );
    expect(
      deriveState({}, resultOf(assistant(4, "", "aborted"), "1", "a")),
    ).toBe("interrupted");
    expect(deriveState(undefined, undefined)).toBe("idle");
  });
});

describe("results", () => {
  test("resultOf reads text, stop reason, and time", () => {
    expect(
      resultOf(assistant(7, "hello", "stop", { errorMessage: "x" }), "1", "a"),
    ).toEqual({
      agentId: "1",
      name: "a",
      entryId: 7,
      text: "hello",
      stopReason: "stop",
      errorMessage: "x",
      at: 42,
    });
    expect(
      resultOf(
        { id: 1, conversationId: 1, kind: "pi.user" } as EntryRecord,
        "1",
        "a",
      ),
    ).toBeUndefined();
  });

  test("outcomeOf maps submissions", () => {
    const done = {
      id: 1,
      conversationId: 1,
      type: "input",
      status: "done",
      entry: 2,
      answer: 3,
    } as never;
    expect(outcomeOf(done, assistant(3, "ok"), "1", "a")?.kind).toBe(
      "answered",
    );
    expect(outcomeOf(done, assistant(3, "", "aborted"), "1", "a")).toEqual({
      kind: "aborted",
    });
    const aborted = {
      id: 1,
      conversationId: 1,
      type: "input",
      status: "unanswered",
      reason: "aborted",
    } as never;
    expect(outcomeOf(aborted, undefined, "1", "a")).toEqual({
      kind: "aborted",
    });
    const failed = {
      id: 1,
      conversationId: 1,
      type: "input",
      status: "unanswered",
      reason: "faulted",
    } as never;
    expect(outcomeOf(failed, undefined, "1", "a")).toEqual({
      kind: "failed",
      reason: "faulted",
    });
    const queued = {
      id: 1,
      conversationId: 1,
      type: "input",
      status: "queued",
    } as never;
    expect(outcomeOf(queued, undefined, "1", "a")).toBeUndefined();
  });
});

describe("activity and usage", () => {
  test("headlines come from bold reasoning summaries", () => {
    expect(
      latestHeadline("**Reading files**\nsome text\n**Planning the fix**"),
    ).toBe("Planning the fix");
    expect(latestHeadline("no headline")).toBeUndefined();
  });

  test("activity reports running tools and retries", () => {
    const live = {
      tools: [{ callId: "c", name: "grep", status: "running" }],
      generation: { attempt: 1, retry: { at: 0, error: "overloaded" } },
      compactions: [{}],
    } as unknown as LiveState;
    expect(activityOf(live)).toEqual({
      tool: "grep",
      retry: "overloaded",
      compacting: true,
    });
  });

  test("usage sums model and tool buckets", () => {
    const usage = summarizeUsage({
      models: {
        "a/b": {
          input: 10,
          output: 5,
          cacheRead: 1,
          cacheWrite: 2,
          cost: { total: 0.5 },
        },
      },
      tools: {
        bash: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.25 },
        },
      },
    } as never);
    expect(usage).toEqual({
      input: 11,
      output: 6,
      cacheRead: 1,
      cacheWrite: 2,
      cost: 0.75,
    });
  });
});
