import { describe, expect, test } from "bun:test";
import type { WorkflowLike } from "../../src/model/ast.js";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { rebuildRunState } from "../../src/run/state.js";
import { renderFlowTree, renderRunTree } from "../../src/ui/tree.js";

describe("renderFlowTree", () => {
  test("the review par reads as a compact icon tree", () => {
    const flow = validateFlow(
      {
        kind: "par",
        branches: {
          bugs: {
            kind: "agent",
            name: "reviewer",
            task: "Review {params.target} strictly for correctness bugs: logic errors, edge cases, races, resource leaks.",
          },
          clarity: {
            kind: "agent",
            name: "reviewer",
            task: "Review {params.target} for readability, duplication, and simplification opportunities.",
          },
        },
        reduce: {
          agent: "worker",
          task: "Merge these code review findings into one prioritized list:\n\n{branches}",
        },
      },
      { params: [{ name: "target" }] },
    );
    const tree = renderFlowTree(flow);
    expect(tree).toBe(
      [
        "⑃ par (all)",
        "├─ bugs → ✦ reviewer · Review {params.target} strictly for correctness bugs: lo…",
        "├─ clarity → ✦ reviewer · Review {params.target} for readability, duplication, and…",
        "└─ ⑂ reduce → worker · Merge these code review findings into one prioritized li…",
      ].join("\n"),
    );
  });

  test("seq is transparent; bindings, map, and loop show their shape", () => {
    const flow = validateFlow({
      kind: "seq",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "List files",
          output: "json",
          as: "files",
        },
        {
          kind: "map",
          over: "{files}",
          concurrency: 4,
          body: { kind: "agent", name: "reviewer", task: "Review {item}" },
          reduce: { agent: "syn", task: "Merge {items}" },
        },
        {
          kind: "loop",
          max: 3,
          until: { eq: ["done", true] },
          body: { kind: "agent", name: "fixer", task: "Fix {last}" },
        },
      ],
    });
    const tree = renderFlowTree(flow);
    const lines = tree.split("\n");
    // Seq steps sit flush left, not nested under a seq node.
    expect(lines[0]).toBe("✦ scout → {files} · List files");
    expect(lines[1]).toBe("⇶ map {files} (×4)");
    expect(tree).toContain("└─ ⑂ reduce → syn · Merge {items}");
    expect(tree).toContain("↺ loop ≤3 until done == true");
    expect(tree).toContain("└─ ✦ fixer · Fix {last}");
    expect(tree).not.toContain("≡");
  });

  test("multi-step branches group under their key; workflow refs show params", () => {
    const def: WorkflowLike = {
      name: "inner",
      params: [{ name: "x" }],
      flow: { kind: "agent", name: "a", task: "use {params.x}" },
    };
    const flow = validateFlow(
      {
        kind: "par",
        branches: {
          quick: { kind: "agent", name: "a", task: "t" },
          slow: {
            kind: "seq",
            steps: [
              { kind: "agent", name: "prep", task: "prepare" },
              { kind: "workflow", name: "inner", params: { x: "42" } },
            ],
          },
        },
      },
      { resolveWorkflow: () => def },
    );
    const tree = renderFlowTree(flow);
    expect(tree).toContain("├─ quick → ✦ a · t");
    expect(tree).toContain("└─ slow:");
    expect(tree).toContain("   ├─ ✦ prep · prepare");
    expect(tree).toContain("   └─ ⧉ workflow inner (x: 42)");
    // The inlined body nests under the ref.
    expect(tree).toContain("      └─ ✦ a · use {params.x}");
  });
});

describe("renderRunTree", () => {
  test("overlays status icons and aggregates map items", async () => {
    const flow = validateFlow({
      kind: "seq",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "list",
          output: "json",
          as: "files",
        },
        {
          kind: "map",
          over: "{files}",
          body: { kind: "agent", name: "reviewer", task: "review {item}" },
        },
      ],
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r1",
      flow,
      runAgent: async (call) =>
        call.agent === "scout" ? { text: '["a","b","c"]' } : { text: "ok" },
      emit: (event) => events.push(event),
    });
    const run = rebuildRunState(events).runs.get("r1");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("● scout → {files} · list");
    // Three map items aggregate on the body line.
    expect(tree).toContain("└─ ● reviewer · review {item} [3/3]");
    // Kind icons are replaced by status icons in overlay mode.
    expect(tree).not.toContain("✦");
  });

  test("failures surface inline with ✗", async () => {
    const flow = validateFlow({ kind: "agent", name: "a", task: "boom" });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r2",
      flow,
      runAgent: async () => {
        throw new Error("kaput");
      },
      emit: (event) => events.push(event),
    });
    const run = rebuildRunState(events).runs.get("r2");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("✗ a · boom — kaput");
  });
});
