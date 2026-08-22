import { describe, expect, test } from "bun:test";
import path from "node:path";
import { discoverWorkflows } from "../src/catalog/workflows.js";
import { emptyUsage } from "../src/engine/types.js";
import type { WorkflowDef } from "../src/model/ast.js";
import { resultValueError } from "../src/model/json-schema.js";
import {
  collectInvocations,
  collectProfileNames,
  validateFlow,
} from "../src/model/validate.js";
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
    outcome?: "approved" | "changes_required" | "cannot_proceed";
    actionable?: unknown[];
    reason?: string | null;
  } = {},
): Record<string, unknown> {
  const outcome = options.outcome ?? "approved";
  return {
    outcome,
    reason:
      options.reason ??
      (outcome === "cannot_proceed"
        ? "The review cannot continue safely."
        : null),
    actionable:
      options.actionable ?? (outcome === "changes_required" ? [finding] : []),
    report: "# Code Review\n\nReview report.",
  };
}

async function runReviewFix(reviewResults: unknown[]) {
  const calls: AgentCall[] = [];
  const pendingReviews = [...reviewResults];
  const outcome = await executeFlow({
    runId: "review-fix-test",
    flow: expandedWorkflow("review-fix"),
    params: { target: "local changes" },
    runAgent: async (call) => {
      calls.push(call);
      const value = call.resultSchema
        ? (pendingReviews.shift() ?? null)
        : "## Implementation summary\n\nApplied the requested fixes.";
      const validationError = resultValueError(value, call.resultSchema);
      if (validationError) throw new Error(validationError);
      return { value, usage: emptyUsage() };
    },
    emit: () => {},
  });
  expect(pendingReviews).toEqual([]);
  return { calls, outcome };
}

describe("project review workflows", () => {
  test("discover without diagnostics or external profiles and skills", () => {
    const workflows = projectWorkflows();
    expect([...workflows.keys()].sort()).toEqual(["review", "review-fix"]);
    expect(workflows.get("review")?.display).toBe("report");
    expect(workflows.get("review-fix")?.display).toBe("report");
    for (const name of workflows.keys()) {
      const flow = expandedWorkflow(name);
      expect([...collectProfileNames(flow)]).toEqual([]);
      for (const invocation of collectInvocations(flow)) {
        expect(invocation.skills).toEqual([]);
      }
    }
  });

  test("approves reviews without actionable findings", async () => {
    const { calls, outcome } = await runReviewFix([reviewResult()]);
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
      profile: undefined,
      thinking: "high",
    });
    expect(calls[0]?.resultSchema).toMatchObject({ type: "object" });
    expect(calls[0]?.skills).toEqual([]);
    expect(calls[0]?.tools).toEqual(["read", "bash"]);
    expect(calls[0]?.scope).toBeUndefined();
  });

  test("runs an Implementer and verifies its changes before approval", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ outcome: "changes_required" }),
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
    expect(calls[1]?.task).toContain(
      "Submit a concise Markdown summary as the complete agent result",
    );
    expect(calls[1]?.skills).toEqual([]);
    expect(calls[1]?.resultSchema).toBeUndefined();
    expect(calls[2]?.task).toContain("Implementer summary:");
    expect(calls[2]?.resultSchema).toMatchObject({ type: "object" });
  });

  test("rejects a structurally malformed initial review before routing", async () => {
    const { calls, outcome } = await runReviewFix([{}]);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("required properties");
    expect(calls).toHaveLength(1);
  });

  test("fails closed when the initial review is semantically inconsistent", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ outcome: "changes_required", actionable: [] }),
    ]);
    expect(outcome.status).toBe("completed");
    expect(outcome.value).toMatchObject({
      outcome: "cannot_proceed",
      reason: "The Reviewer returned semantically inconsistent review data.",
      round_index: null,
      report: null,
      actionable: [],
      implementation: null,
    });
    expect(calls).toHaveLength(1);
  });

  test("returns a flat initial cannot_proceed review without repairing", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ outcome: "cannot_proceed" }),
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

  test("fails when a verification review is structurally malformed", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ outcome: "changes_required" }),
      "{}",
    ]);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("must be object");
    expect(calls).toHaveLength(3);
  });

  test("returns cannot_proceed when verification reports no progress", async () => {
    const { calls, outcome } = await runReviewFix([
      reviewResult({ outcome: "changes_required" }),
      reviewResult({ outcome: "cannot_proceed", actionable: [finding] }),
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
    const actionable = reviewResult({ outcome: "changes_required" });
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
    expect(calls.filter((call) => call.resultSchema)).toHaveLength(4);
    expect(calls.filter((call) => !call.resultSchema)).toHaveLength(3);
    expect(calls.at(-1)?.resultSchema).toMatchObject({ type: "object" });
  });
});
