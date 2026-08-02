import { describe, expect, test } from "bun:test";
import path from "node:path";
import { discoverWorkflows } from "../src/catalog/workflows.js";
import { emptyUsage } from "../src/engine/types.js";
import type { WorkflowDef } from "../src/model/ast.js";
import { collectAgentNames, validateFlow } from "../src/model/validate.js";
import type { AgentCall } from "../src/run/interpreter.js";
import { executeFlow } from "../src/run/interpreter.js";

const projectDir = path.resolve(import.meta.dir, "..");

function projectWorkflows(): Map<string, WorkflowDef> {
  const discovery = discoverWorkflows(projectDir, "project");
  expect(discovery.diagnostics).toEqual([]);
  return new Map(
    discovery.workflows.map((workflow) => [workflow.name, workflow]),
  );
}

function expandedWorkflow(name: string) {
  const workflows = projectWorkflows();
  const workflow = workflows.get(name);
  if (!workflow) throw new Error(`missing project workflow '${name}'`);
  return validateFlow(workflow.flow, {
    params: workflow.params,
    resolveWorkflow: (referencedName) => workflows.get(referencedName),
    selfName: workflow.name,
  });
}

const finding = {
  id: "BUG-1",
  severity: "P2",
  category: "correctness",
  title: "Fix the bug",
  problem: "The current behavior is incorrect.",
  fix: "Apply the fix.",
  context: "The implementation demonstrates the incorrect behavior.",
  locations: ["src/file.ts:10-20"],
};

function reviewResult(
  options: {
    p1?: number;
    p2?: number;
    p3?: number;
    p4?: number;
    actionable?: unknown[];
    stalled?: boolean;
    cannotProceed?: boolean;
  } = {},
): string {
  const p1 = options.p1 ?? 0;
  const p2 = options.p2 ?? 0;
  const p3 = options.p3 ?? 0;
  return JSON.stringify({
    counts: { p1, p2, p3, p4: options.p4 ?? 0 },
    actionable: options.actionable ?? (p1 + p2 + p3 > 0 ? [finding] : []),
    stalled: options.stalled ?? false,
    cannot_proceed: options.cannotProceed ?? false,
    reason:
      options.stalled || options.cannotProceed
        ? "The review cannot continue safely."
        : null,
    lower_confidence_observations: [],
    report: "# Code Review\n\nReview report.",
  });
}

async function runReviewFix(reviewResults: string[]) {
  const calls: AgentCall[] = [];
  const pendingReviews = [...reviewResults];
  const outcome = await executeFlow({
    runId: "review-fix-test",
    flow: expandedWorkflow("review-fix"),
    params: { target: "local changes" },
    runAgent: async (call) => {
      calls.push(call);
      const text =
        call.output === "json"
          ? pendingReviews.shift()
          : "## Implementation summary\n\nApplied the requested fixes.";
      if (text === undefined) throw new Error("missing stub review result");
      return { text, usage: emptyUsage() };
    },
    emit: () => {},
  });
  expect(pendingReviews).toEqual([]);
  return { calls, outcome };
}

describe("project review workflows", () => {
  test("discover without diagnostics and use no named reviewer profile", () => {
    const workflows = projectWorkflows();
    expect([...workflows.keys()].sort()).toEqual(["review", "review-fix"]);
    for (const name of workflows.keys()) {
      expect([...collectAgentNames(expandedWorkflow(name))]).toEqual([]);
    }
  });

  test("approves P4-only reviews without invoking the Implementer", async () => {
    const { calls, outcome } = await runReviewFix([reviewResult({ p4: 1 })]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "approved",
      reason: null,
      round_index: null,
      report: "# Code Review\n\nReview report.",
      actionable: [],
      implementation: null,
    });
    expect(outcome.value).not.toHaveProperty("review");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agent: undefined,
      output: "json",
      thinking: "high",
      skills: ["code-review"],
      scope: "user",
    });
  });

  test("runs an Implementer and verifies its changes before approval", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ p2: 1 }),
      reviewResult(),
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "approved",
      round_index: 0,
      report: "# Code Review\n\nReview report.",
      actionable: [],
      implementation:
        "## Implementation summary\n\nApplied the requested fixes.",
    });
    expect(outcome.value).not.toHaveProperty("review");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.task).toContain("Act as the Implementer");
    expect(calls[1]?.output).toBe("text");
    expect(calls[2]?.task).toContain("Implementer summary:");
    expect(calls[2]?.output).toBe("json");
  });

  test("fails closed when the initial review contract is malformed", async () => {
    for (const invalidReview of [
      "{}",
      reviewResult({ p2: 1, actionable: [] }),
    ]) {
      const { calls, outcome } = await runReviewFix([invalidReview]);
      expect(outcome.status).toBe("completed");
      expect(outcome.value).toMatchObject({
        outcome: "cannot_proceed",
        round_index: null,
        report: null,
        actionable: [],
        implementation: null,
      });
      expect(calls).toHaveLength(1);
    }
  });

  test("returns a flat initial cannot_proceed review without repairing", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ cannotProceed: true }),
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "cannot_proceed",
      reason: "The review cannot continue safely.",
      round_index: null,
      report: "# Code Review\n\nReview report.",
      actionable: [],
      implementation: null,
    });
    expect(calls).toHaveLength(1);
  });

  test("fails closed with round metadata when verification is malformed", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ p2: 1 }),
      "{}",
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "cannot_proceed",
      round_index: 0,
      report: null,
      actionable: [],
      implementation:
        "## Implementation summary\n\nApplied the requested fixes.",
    });
    expect(calls).toHaveLength(3);
  });

  test("returns cannot_proceed when verification reports no progress", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ p2: 1 }),
      reviewResult({ p2: 1, stalled: true }),
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "cannot_proceed",
      round_index: 0,
      actionable: [finding],
    });
    expect(calls).toHaveLength(3);
  });

  test("returns exhausted only after three complete implementation rounds", async () => {
    const actionable = reviewResult({ p2: 1 });
    const { calls, outcome } = await runReviewFix([
      actionable,
      actionable,
      actionable,
      actionable,
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "exhausted",
      round_index: 2,
      report: "# Code Review\n\nReview report.",
      actionable: [finding],
      implementation:
        "## Implementation summary\n\nApplied the requested fixes.",
    });
    expect(outcome.value).not.toHaveProperty("review");
    expect(calls).toHaveLength(7);
    expect(calls.filter((call) => call.output === "json")).toHaveLength(4);
    expect(calls.filter((call) => call.output === "text")).toHaveLength(3);
    expect(calls.at(-1)?.output).toBe("json");
  });
});
