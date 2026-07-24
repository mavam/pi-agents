import { describe, expect, test } from "bun:test";
import { validateFlow } from "../../src/model/validate.js";
import { toMermaid } from "../../src/ui/mermaid.js";

describe("toMermaid", () => {
  test("renders the full algebra deterministically", () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "list",
          output: "json",
          as: "files",
        },
        {
          kind: "parallel",
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

  test("switch renders a decision head, labeled arm edges, and a join", () => {
    const flow = validateFlow(
      {
        kind: "switch",
        on: "{params.gate}",
        cases: [
          {
            when: { eq: ["status", "approved"] },
            then: { kind: "agent", name: "shipper", task: "ship" },
          },
          {
            when: { or: [{ exists: "findings" }, { eq: ["retry", true] }] },
            then: { kind: "agent", name: "fixer", task: "fix" },
          },
        ],
        else: { kind: "value", value: "done", label: "outcome" },
      },
      { params: [{ name: "gate" }] },
    );
    const first = toMermaid(flow);
    expect(first).toBe(toMermaid(flow));
    expect(first).toBe(
      [
        "flowchart TD",
        '  n0{"switch {params.gate}"}',
        '  n1(("·"))',
        '  n2["shipper"]',
        "  n0 -->|when status == 'approved'| n2",
        "  n2 --> n1",
        '  n3["fixer"]',
        "  n0 -->|when (exists(findings) ∣∣ retry == true)| n3",
        "  n3 --> n1",
        '  n4[/"outcome"/]',
        "  n0 -->|else| n4",
        "  n4 --> n1",
      ].join("\n"),
    );
    // Pipes from or-predicates never leak into edge-label delimiters.
    expect(first).not.toContain("||");
  });

  test("anonymous leaves and reducers label as ad-hoc", () => {
    const flow = validateFlow({
      kind: "parallel",
      branches: { a: { kind: "agent", task: "ta" } },
      reduce: { task: "merge {branches}" },
    });
    const diagram = toMermaid(flow);
    expect(diagram).toContain('["ad-hoc"]');
    expect(diagram).toContain("reduce: ad-hoc");
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
