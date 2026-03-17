import { describe, expect, it } from "bun:test";
import { renderFlowAscii, toMermaid } from "../extensions/agent/mermaid.ts";
import type { FlowSpec } from "../extensions/agent/types.ts";

describe("toMermaid", () => {
  it("renders a single spawn as a stadium node", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "do work",
    };
    const result = toMermaid(flow);
    expect(result).toBe(
      [
        "flowchart TD",
        '  n0(["worker"])',
        "  classDef spawn fill:#e1f5fe,stroke:#0288d1,color:#01579b",
        "  class n0 spawn",
      ].join("\n"),
    );
  });

  it("renders a sequence as a chain of edges", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "spawn", agent: "analyzer", task: "analyze" },
        { kind: "spawn", agent: "reviewer", task: "review" },
      ],
    };
    const result = toMermaid(flow);
    expect(result).toContain('n0(["analyzer"])');
    expect(result).toContain('n1(["reviewer"])');
    expect(result).toContain("n0 --> n1");
  });

  it("renders a fork-join with sorted branches and converging edges", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          id: "fanout",
          branches: {
            // Intentionally out of alphabetical order.
            b: { kind: "spawn", agent: "worker-b", task: "task b" },
            a: { kind: "spawn", agent: "worker-a", task: "task a" },
          },
        },
        {
          kind: "join",
          from: "fanout",
          mode: "all",
        },
      ],
    };
    const result = toMermaid(flow);

    // Fork diamond and branch spawns in sorted order.
    expect(result).toContain('n0{"fanout"}');
    expect(result).toContain('n1(["worker-a"])');
    expect(result).toContain('n2(["worker-b"])');
    expect(result).toContain('n0 -->|"a"| n1');
    expect(result).toContain('n0 -->|"b"| n2');

    // Join collects branches.
    expect(result).toContain('n3{"join: all"}');
    expect(result).toContain("n1 --> n3");
    expect(result).toContain("n2 --> n3");

    // No direct fork→join edge (the null endpoints skip it).
    const lines = result.split("\n");
    const directForkJoin = lines.find(
      (l) => l.includes("n0 --> n3") && !l.includes("|"),
    );
    expect(directForkJoin).toBeUndefined();
  });

  it("renders a loop with a dotted repeat edge", () => {
    const flow: FlowSpec = {
      kind: "loop",
      id: "retry",
      maxIterations: 3,
      body: { kind: "spawn", agent: "checker", task: "check" },
    };
    const result = toMermaid(flow);
    expect(result).toContain('n0{{"retry"}}');
    expect(result).toContain('n1(["checker"])');
    expect(result).toContain("n0 --> n1");
    expect(result).toContain('n1 -.->|"repeat"| n0');
  });

  it("is deterministic across multiple calls", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          id: "f",
          branches: {
            x: { kind: "spawn", agent: "a", task: "t" },
            y: { kind: "spawn", agent: "b", task: "t" },
          },
        },
        { kind: "join", from: "f", mode: "all" },
        { kind: "spawn", agent: "c", task: "final" },
      ],
    };
    const first = toMermaid(flow);
    const second = toMermaid(flow);
    const third = toMermaid(flow);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("remains deterministic regardless of object key insertion order", () => {
    const branchesAB: Record<string, FlowSpec> = {};
    branchesAB.a = { kind: "spawn", agent: "x", task: "t" };
    branchesAB.b = { kind: "spawn", agent: "y", task: "t" };

    const branchesBA: Record<string, FlowSpec> = {};
    branchesBA.b = { kind: "spawn", agent: "y", task: "t" };
    branchesBA.a = { kind: "spawn", agent: "x", task: "t" };

    const flowAB: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "fork", id: "f", branches: branchesAB },
        { kind: "join", from: "f", mode: "all" },
      ],
    };
    const flowBA: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "fork", id: "f", branches: branchesBA },
        { kind: "join", from: "f", mode: "all" },
      ],
    };
    expect(toMermaid(flowAB)).toBe(toMermaid(flowBA));
  });

  it("supports LR direction", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "do work",
    };
    const result = toMermaid(flow, { direction: "LR" });
    expect(result).toContain("flowchart LR");
    expect(result).not.toContain("flowchart TD");
  });

  it("includes title as Mermaid frontmatter", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "do work",
    };
    const result = toMermaid(flow, { title: "My Workflow" });
    const lines = result.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("title: My Workflow");
    expect(lines[2]).toBe("---");
    expect(lines[3]).toBe("flowchart TD");
  });

  it("uses label when present instead of agent name", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      label: "Custom Label",
      agent: "worker",
      task: "do work",
    };
    const result = toMermaid(flow);
    expect(result).toContain('n0(["Custom Label"])');
    expect(result).not.toContain("worker");
  });

  it("uses fork id as label when no label is given", () => {
    const flow: FlowSpec = {
      kind: "fork",
      id: "my-fork",
      branches: {
        a: { kind: "spawn", agent: "w", task: "t" },
      },
    };
    const result = toMermaid(flow);
    expect(result).toContain('n0{"my-fork"}');
  });

  it("uses fork label over id when both are given", () => {
    const flow: FlowSpec = {
      kind: "fork",
      id: "f",
      label: "Fan Out",
      branches: {
        a: { kind: "spawn", agent: "w", task: "t" },
      },
    };
    const result = toMermaid(flow);
    expect(result).toContain('n0{"Fan Out"}');
    expect(result).not.toContain('"f"');
  });

  it("escapes double quotes in labels", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      label: 'worker "special"',
      agent: "worker",
      task: "do work",
    };
    const result = toMermaid(flow);
    expect(result).toContain("&quot;");
    // The raw unescaped quote must not appear inside the Mermaid node def.
    expect(result).not.toMatch(/\(?\["worker "special""\]?\)/);
  });

  it("shows quorum value in join label", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          id: "f",
          branches: {
            a: { kind: "spawn", agent: "w", task: "t" },
            b: { kind: "spawn", agent: "w", task: "t" },
            c: { kind: "spawn", agent: "w", task: "t" },
          },
        },
        {
          kind: "join",
          from: "f",
          mode: "quorum",
          quorum: 2,
          onFailure: "collectErrors",
        },
      ],
    };
    const result = toMermaid(flow);
    expect(result).toContain("join: quorum(2)");
  });

  it("handles empty sequence gracefully", () => {
    const flow: FlowSpec = { kind: "sequence", steps: [] };
    const result = toMermaid(flow);
    expect(result).toContain('n0["empty"]');
  });

  it("renders a complex nested workflow", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "spawn", id: "init", agent: "initializer", task: "init" },
        {
          kind: "fork",
          id: "parallel",
          branches: {
            fast: { kind: "spawn", agent: "fast-worker", task: "fast" },
            slow: {
              kind: "sequence",
              steps: [
                { kind: "spawn", agent: "prep", task: "prepare" },
                { kind: "spawn", agent: "slow-worker", task: "slow" },
              ],
            },
          },
        },
        { kind: "join", from: "parallel", mode: "all" },
        {
          kind: "loop",
          id: "validate",
          maxIterations: 3,
          body: { kind: "spawn", agent: "validator", task: "validate" },
        },
      ],
    };
    const result = toMermaid(flow, { title: "Complex Pipeline" });

    // All four class types appear.
    expect(result).toContain("classDef spawn");
    expect(result).toContain("classDef fork");
    expect(result).toContain("classDef join");
    expect(result).toContain("classDef loop");

    // The join's exit connects to the loop.
    // n0=init, n1=fork, n2=fast-worker, n3=prep, n4=slow-worker,
    // n5=join, n6=loop, n7=validator
    expect(result).toContain("n0 --> n1"); // init → fork
    expect(result).toContain("n5 --> n6"); // join → loop
    expect(result).toContain("n6 --> n7"); // loop → validator body
    expect(result).toContain('n7 -.->|"repeat"| n6'); // validator → loop

    // Fork branch edges.
    expect(result).toContain('n1 -->|"fast"| n2');
    expect(result).toContain('n1 -->|"slow"| n3');

    // Slow branch internal edge.
    expect(result).toContain("n3 --> n4");

    // Join collects.
    expect(result).toContain("n2 --> n5"); // fast → join
    expect(result).toContain("n4 --> n5"); // slow → join
  });

  it("only emits classDefs for node types actually used", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "work",
    };
    const result = toMermaid(flow);
    expect(result).toContain("classDef spawn");
    expect(result).not.toContain("classDef fork");
    expect(result).not.toContain("classDef join");
    expect(result).not.toContain("classDef loop");
  });

  it("handles a loop wrapping a sequence body", () => {
    const flow: FlowSpec = {
      kind: "loop",
      id: "outer",
      maxIterations: 5,
      body: {
        kind: "sequence",
        steps: [
          { kind: "spawn", agent: "step-a", task: "a" },
          { kind: "spawn", agent: "step-b", task: "b" },
        ],
      },
    };
    const result = toMermaid(flow);
    // n0=loop, n1=step-a, n2=step-b
    expect(result).toContain("n0 --> n1"); // loop → first body step
    expect(result).toContain("n1 --> n2"); // body internal chain
    expect(result).toContain('n2 -.->|"repeat"| n0'); // last body step → loop
  });
});

describe("renderFlowAscii", () => {
  it("renders a single spawn as Unicode box-drawing art", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "do work",
    };
    const result = renderFlowAscii(flow);
    expect(result).toContain("worker");
    // Unicode box-drawing characters.
    expect(result).toMatch(/[─│┌┐└┘┬┤├┴(]/);
  });

  it("renders a sequence with connected nodes", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "spawn", agent: "analyzer", task: "analyze" },
        { kind: "spawn", agent: "reviewer", task: "review" },
      ],
    };
    const result = renderFlowAscii(flow);
    expect(result).toContain("analyzer");
    expect(result).toContain("reviewer");
    // Should have an arrow connecting them.
    expect(result).toMatch(/[▼►v>]/);
  });

  it("renders a fork-join with branch labels", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          id: "fanout",
          branches: {
            a: { kind: "spawn", agent: "worker-a", task: "task a" },
            b: { kind: "spawn", agent: "worker-b", task: "task b" },
          },
        },
        { kind: "join", from: "fanout", mode: "all" },
      ],
    };
    const result = renderFlowAscii(flow);
    expect(result).toContain("fanout");
    expect(result).toContain("worker-a");
    expect(result).toContain("worker-b");
    expect(result).toContain("join: all");
  });

  it("supports ASCII mode via useAscii option", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "work",
    };
    const unicode = renderFlowAscii(flow);
    const ascii = renderFlowAscii(flow, { useAscii: true });

    // Both contain the label.
    expect(unicode).toContain("worker");
    expect(ascii).toContain("worker");

    // ASCII mode should not contain Unicode box-drawing characters.
    expect(ascii).not.toMatch(/[─│┌┐└┘┬┤├┴▼►]/);
  });

  it("produces no ANSI escape codes with colorMode none", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "work",
    };
    const result = renderFlowAscii(flow, { colorMode: "none" });
    // ESC character should not be present.
    expect(result).not.toContain("\x1b");
  });

  it("produces ANSI escape codes with colorMode ansi256", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "work",
    };
    const result = renderFlowAscii(flow, { colorMode: "ansi256" });
    // ANSI escape sequence expected.
    expect(result).toContain("\x1b[");
  });

  it("is deterministic across multiple calls", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          id: "f",
          branches: {
            x: { kind: "spawn", agent: "a", task: "t" },
            y: { kind: "spawn", agent: "b", task: "t" },
          },
        },
        { kind: "join", from: "f", mode: "all" },
      ],
    };
    const first = renderFlowAscii(flow);
    const second = renderFlowAscii(flow);
    expect(first).toBe(second);
  });

  it("renders a loop with repeat edge", () => {
    const flow: FlowSpec = {
      kind: "loop",
      id: "retry",
      maxIterations: 3,
      body: { kind: "spawn", agent: "checker", task: "check" },
    };
    const result = renderFlowAscii(flow);
    expect(result).toContain("retry");
    expect(result).toContain("checker");
    expect(result).toContain("repeat");
  });
});
