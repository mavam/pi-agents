import { describe, expect, test } from "bun:test";
import { describeReport } from "../../src/agents/failures.js";

describe("harness reports", () => {
  const subject = ({ conversation }: { conversation?: string }) =>
    conversation === "7" ? "Agent api" : undefined;
  const task = (kind: string) => ({ id: "9", kind, conversation: "7" });

  test("name the agent, its work, and what to do", () => {
    expect(
      describeReport(
        { error: new Error("x"), type: "task_parked", task: task("pi.tool") },
        subject,
      ),
    ).toBe(
      "Agent api stalled: Pi crashed or was killed repeatedly while its tool call ran. Retry it with r in /agents, or stop it.",
    );
    expect(
      describeReport(
        {
          error: new Error("boom"),
          type: "task_faulted",
          reason: "threw",
          task: task("pi-agents.graph"),
          extension: "pi-agents-graphs",
        },
        subject,
      ),
    ).toBe("Agent api: its graph (pi-agents-graphs) failed: boom");
    expect(
      describeReport(
        { error: new Error("no key"), type: "host_error", callback: "models" },
        subject,
      ),
    ).toBe("Pi's models failed for agents: no key");
  });

  test("a failed session reports through the recovery only", () => {
    expect(
      describeReport(
        { error: new Error("disk"), type: "session_failed" },
        subject,
      ),
    ).toBeUndefined();
  });
});
