import { describe, expect, test } from "bun:test";
import { describeReport } from "../../src/agents/failures.js";

describe("harness reports", () => {
  const subject = ({ conversation }: { conversation?: string }) =>
    conversation === "7" ? "Agent api" : undefined;
  const task = (kind: string) => ({ id: "9", kind, conversation: "7" });

  test("name the agent, its work, and what to do", () => {
    expect(
      describeReport(
        {
          error: new Error("x"),
          kind: "task_interrupted",
          reason: "restart_limit",
          task: task("pi.generation"),
        },
        subject,
      ),
    ).toBe(
      "Agent api failed: Pi crashed or was killed repeatedly. Continue it with r in /agents.",
    );
    expect(
      describeReport(
        {
          error: new Error("boom"),
          kind: "task_faulted",
          reason: "threw",
          task: task("pi-agents.graph"),
          extension: "pi-agents-graphs",
        },
        subject,
      ),
    ).toBe("Agent api: its graph (pi-agents-graphs) failed: boom");
    expect(
      describeReport(
        { error: new Error("no key"), kind: "host_error", callback: "models" },
        subject,
      ),
    ).toBe("Pi's models failed for agents: no key");
  });

  test("a failed storage reports through the recovery only", () => {
    expect(
      describeReport(
        { error: new Error("disk"), kind: "storage_failed" },
        subject,
      ),
    ).toBeUndefined();
  });
});
