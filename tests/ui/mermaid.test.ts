import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import { toMermaid } from "../../src/ui/mermaid.js";

describe("toMermaid", () => {
  test("renders the full algebra deterministically", () => {
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
          kind: "par",
          branches: {
            b: { kind: "agent", name: "y", task: "tb" },
            a: { kind: "agent", name: "x", task: "ta" },
          },
          mode: { quorum: 2 },
          reduce: { agent: "syn", task: "merge {branches}" },
        },
        {
          kind: "map",
          over: "{files}",
          body: { kind: "agent", name: "reviewer", task: "review {item}" },
        },
        {
          kind: "loop",
          body: { kind: "agent", name: "fixer", task: "fix", output: "json" },
          max: 3,
          until: { eq: ["done", true] },
        },
      ],
    });
    const first = toMermaid(flow);
    const second = toMermaid(flow);
    expect(first).toBe(second);
    expect(first).toContain("flowchart TD");
    expect(first).toContain('n0["scout"]');
    // Branch keys visit in sorted order: a before b.
    expect(first.indexOf("|a|")).toBeLessThan(first.indexOf("|b|"));
    expect(first).toContain('(("quorum 2"))');
    expect(first).toContain("reduce: syn");
    expect(first).toContain("map {files}");
    expect(first).toContain("|per item|");
    expect(first).toContain("loop ≤3");
    expect(first).toContain("-.->|repeat|");
  });

  test("workflow refs render as subgraphs", () => {
    const flow = validateFlow(
      { kind: "workflow", name: "review", params: { target: "src/" } },
      {
        resolveWorkflow: (name) =>
          name === "review"
            ? {
                name: "review",
                params: [{ name: "target" }],
                flow: {
                  kind: "agent",
                  name: "reviewer",
                  task: "review {params.target}",
                },
              }
            : undefined,
      },
    );
    const diagram = toMermaid(flow);
    expect(diagram).toContain('subgraph n0_wf["workflow: review"]');
    expect(diagram).toContain('"reviewer"');
  });
});
