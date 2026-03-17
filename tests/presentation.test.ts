import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  buildWidgetLines,
  formatAgentResultXml,
  formatFlowTree,
  formatWorkflowResultXml,
  renderAgentCall,
  renderWorkflowResult,
  stripResultXmlEnvelope,
} from "../extensions/agent/presentation.ts";
import { createRunRuntimeState } from "../extensions/agent/state.ts";
import type { FlowSpec, RunResultDetails } from "../extensions/agent/types.ts";

const theme = {
  fg(_color: string, text: string) {
    return `\u001b[36m${text}\u001b[39m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
} as unknown as Theme;

describe("agent presentation", () => {
  it("wraps long agent task text to the terminal width", () => {
    const renderer = renderAgentCall(
      {
        name: "explorer",
        task: "Explore this codebase thoroughly. Understand its structure, purpose, key files, and architecture. Provide a comprehensive summary of what you find.",
      },
      theme,
    );

    const lines = renderer.render(40);
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.join("\n")).toContain("Explore this codebase thoroughly");
  });

  it("escapes agent result text inside XML envelopes", () => {
    const raw = '</agent_result><evil attr="1">oops & more</evil>';
    const xml = formatAgentResultXml("worker", raw);

    expect(xml).toContain('<agent_result agent="worker">');
    expect(xml).toContain(
      '&lt;/agent_result&gt;&lt;evil attr="1"&gt;oops &amp; more&lt;/evil&gt;',
    );
    expect(xml).not.toContain(raw);
    expect(stripResultXmlEnvelope(xml)).toBe(raw);
  });

  it("preserves arbitrary workflow JSON outputs losslessly", () => {
    const payload = {
      branches: { team: "red" },
      errors: { status: "ok" },
      done: true,
    };
    const xml = formatWorkflowResultXml(
      {
        nodeId: "root:1",
        kind: "spawn",
        status: "completed",
        agent: "explorer",
        text: JSON.stringify(payload),
        output: payload,
        run: {
          agent: "explorer",
          agentSource: "project",
          skills: [],
          missingSkills: [],
          exitCode: 0,
          stderr: "",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 1,
            turns: 1,
          },
          discoveryDiagnostics: [],
          scope: "both",
        },
      },
      "run-xml",
    );

    expect(xml).toContain('<workflow_result run="run-xml" kind="spawn">');
    expect(xml).toContain('<output format="json">');
    expect(xml).not.toContain("<branch name=");

    expect(JSON.parse(stripResultXmlEnvelope(xml))).toEqual(payload);
  });

  it("wraps long workflow result output to the terminal width", () => {
    const details: RunResultDetails = {
      run: {
        id: "12345678-1234-5678-1234-567812345678",
        rootNodeId: "root:1",
        label: "workflow",
        status: "completed",
        startedAt: Date.now(),
        depth: 0,
        flow: {
          kind: "spawn",
          agent: "explorer",
          task: "summarize",
        },
        cwd: "/tmp",
        scope: "both",
      },
      nodes: [],
      result: {
        nodeId: "root:1",
        kind: "spawn",
        status: "completed",
        agent: "explorer",
        text: "",
        output:
          "This is a very long workflow result that should wrap instead of crashing the TUI when rendered into a narrow terminal.",
        run: {
          toolCallId: "tool-1",
          agent: "explorer",
          agentSource: "project",
          filePath: "/tmp/explorer.md",
          cwd: "/tmp",
          scope: "both",
          task: "summarize",
          output: "done",
          exitCode: 0,
          stderr: "",
          durationMs: 1,
          usage: {
            input: 1,
            output: 1,
            contextTokens: 1,
            turns: 1,
            cost: "$0.000",
          },
          discoveryDiagnostics: [],
          missingSkills: [],
        },
      },
    };

    const renderer = renderWorkflowResult(
      {
        content: [{ type: "text", text: "done" }],
        details,
      },
      false,
      theme,
    );

    const lines = renderer.render(32);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(32);
    }
  });

  it("collapses structured workflow outputs by default", () => {
    const details: RunResultDetails = {
      run: {
        id: "r-structured",
        rootNodeId: "root:1",
        label: "workflow",
        status: "completed",
        startedAt: Date.now(),
        depth: 0,
        flow: {
          kind: "fork",
          id: "fanout",
          branches: {
            a: { kind: "spawn", agent: "worker", task: "A" },
          },
        },
        cwd: "/tmp",
        scope: "both",
      },
      nodes: [],
      result: {
        nodeId: "root:1",
        kind: "fork",
        status: "completed",
        branches: {
          a: {
            branchKey: "a",
            result: {
              nodeId: "a:1",
              kind: "spawn",
              status: "completed",
              text: "full body",
              output: "## Very long markdown\n\nLots of details here.",
              agent: "worker",
              run: {
                agent: "worker",
                agentSource: "project",
                exitCode: 0,
                stderr: "",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 1,
                  turns: 1,
                },
                discoveryDiagnostics: [],
                missingSkills: [],
                scope: "both",
              },
            },
          },
        },
        output: {
          branches: {
            tests:
              "## TESTS Lens Review\n\nA very long detailed markdown review that should not explode the collapsed renderer.",
          },
          errors: {
            ux: 'Unknown agent "ux-reviewer" for scope=both.',
          },
        },
      },
    };

    const renderer = renderWorkflowResult(
      {
        content: [{ type: "text", text: "done" }],
        details,
      },
      false,
      theme,
    );

    const text = renderer.render(120).join("\n");
    expect(text).toContain("1 branch result(s), 1 error(s)");
    expect(text).toContain("- tests:");
    expect(text).toContain("- ux error:");
    expect(text).not.toContain("A very long detailed markdown review");
  });

  it("collapses error-only workflow outputs aggressively", () => {
    const details: RunResultDetails = {
      run: {
        id: "r-errors",
        rootNodeId: "root:1",
        label: "workflow",
        status: "completed",
        startedAt: Date.now(),
        depth: 0,
        flow: { kind: "fork", id: "fanout", branches: {} },
        cwd: "/tmp",
        scope: "both",
      },
      nodes: [],
      result: {
        nodeId: "root:1",
        kind: "fork",
        status: "completed",
        branches: {},
        output: {
          branches: {},
          errors: {
            a: 'Unknown agent "Explorer" for scope=both. Available: explorer',
            b: 'Unknown agent "Explorer" for scope=both. Available: explorer',
          },
        },
      },
    };

    const renderer = renderWorkflowResult(
      { content: [{ type: "text", text: "done" }], details },
      false,
      theme,
    );

    const text = renderer.render(120).join("\n");
    expect(text).toContain("2 branch error(s)");
    expect(text).toContain('Unknown agent "Explorer"');
    expect(text).not.toContain("- a error:");
    expect(text).not.toContain("- b error:");
  });

  it("omits the result section while a workflow is still running", () => {
    const details: RunResultDetails = {
      run: {
        id: "r-running",
        rootNodeId: "root:1",
        label: "workflow",
        status: "running",
        startedAt: Date.now(),
        depth: 0,
        flow: { kind: "spawn", agent: "worker", task: "work" },
        cwd: "/tmp",
        scope: "both",
      },
      nodes: [],
    };

    const renderer = renderWorkflowResult(
      { content: [{ type: "text", text: "3 nodes tracked" }], details },
      false,
      theme,
    );

    const text = renderer.render(120).join("\n");
    expect(text).toContain("workflow · running");
    expect(text).toContain("run=r-running".slice(0, 12));
    expect(text).not.toContain("Result");
    expect(text).not.toContain("3 nodes tracked");
  });

  it("renders the runs widget with just a header for a single spawn", () => {
    const runtimeState = createRunRuntimeState();
    const startedAt = Date.now();

    runtimeState.runs.set("run-1", {
      id: "run-1",
      rootNodeId: "root:1",
      label: "explorer",
      status: "running",
      startedAt,
      depth: 0,
      flow: {
        kind: "spawn",
        id: "explorer",
        agent: "explorer",
        task: "find files",
      },
      cwd: "/tmp",
      scope: "both",
    });
    runtimeState.nodes.set("root:1", {
      id: "root:1",
      runId: "run-1",
      specId: "explorer",
      kind: "spawn",
      label: "explorer",
      status: "running",
      startedAt,
    });
    runtimeState.order.push("run-1");

    const plainTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as import("@mariozechner/pi-coding-agent").Theme;

    const lines = buildWidgetLines(runtimeState, "⠹", plainTheme, 120);

    // Heading + single header line, no redundant flow tree.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Flows");
    expect(lines[1]).toContain("explorer");
    expect(lines[1]).toContain("run-1");
  });

  it("hides detached runs from the live widget", () => {
    const runtimeState = createRunRuntimeState();
    const startedAt = Date.now();

    runtimeState.runs.set("run-1", {
      id: "run-1",
      rootNodeId: "root:1",
      label: "workflow",
      status: "running",
      startedAt,
      detachedAt: startedAt + 1,
      depth: 0,
      flow: {
        kind: "fork",
        id: "fanout",
        branches: {
          a: { kind: "spawn", agent: "explorer", task: "branch a" },
          b: { kind: "spawn", agent: "explorer", task: "branch b" },
        },
      },
      cwd: "/tmp",
      scope: "both",
    });
    runtimeState.order.push("run-1");

    const plainTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as import("@mariozechner/pi-coding-agent").Theme;

    const lines = buildWidgetLines(runtimeState, "⠹", plainTheme, 120);

    expect(lines).toEqual([]);
  });

  it("renders a static flow tree for a complex workflow", () => {
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

    const lines = formatFlowTree(flow);

    expect(lines).toEqual([
      "● initializer",
      "◇ parallel",
      "├─ fast → ● fast-worker",
      "└─ slow",
      "   ├─ ● prep",
      "   └─ ● slow-worker",
      "◆ join: all ← parallel",
      "◎ validate (max 3)",
      "└─ ● validator",
    ]);
  });

  it("overlays status icons from runtime state", () => {
    const flow: FlowSpec = {
      kind: "sequence",
      steps: [
        { kind: "spawn", id: "s1", agent: "analyzer", task: "analyze" },
        { kind: "spawn", id: "s2", agent: "reviewer", task: "review" },
      ],
    };

    const runtimeState = createRunRuntimeState();
    const now = Date.now();
    runtimeState.runs.set("r1", {
      id: "r1",
      rootNodeId: "seq:1",
      label: "test",
      status: "running",
      startedAt: now,
      depth: 0,
      flow,
      cwd: "/tmp",
      scope: "both",
    });
    runtimeState.nodes.set("n1", {
      id: "n1",
      runId: "r1",
      specId: "s1",
      specPath: "flow.steps[0]",
      kind: "spawn",
      status: "completed",
      startedAt: now,
      completedAt: now + 1,
    });
    runtimeState.nodes.set("n2", {
      id: "n2",
      runId: "r1",
      specId: "s2",
      specPath: "flow.steps[1]",
      kind: "spawn",
      status: "running",
      startedAt: now + 1,
    });
    runtimeState.order.push("r1");

    const lines = formatFlowTree(flow, runtimeState, "r1");

    expect(lines).toEqual(["✔ analyzer", "⠹ reviewer"]);
  });

  it("renders a single spawn without tree connectors", () => {
    const flow: FlowSpec = {
      kind: "spawn",
      agent: "worker",
      task: "work",
    };
    const lines = formatFlowTree(flow);
    expect(lines).toEqual(["● worker"]);
  });

  it("overlays status for fork branches without explicit node ids", () => {
    const flow: FlowSpec = {
      kind: "fork",
      id: "fanout",
      label: "Three-Lens Code Review",
      branches: {
        code_quality_and_docs: {
          kind: "spawn",
          agent: "worker",
          task: "lens 1",
        },
        performance_and_architecture: {
          kind: "spawn",
          agent: "worker",
          task: "lens 2",
        },
        security_and_safety: {
          kind: "spawn",
          agent: "worker",
          task: "lens 3",
        },
      },
    };

    const runtimeState = createRunRuntimeState();
    const now = Date.now();
    runtimeState.runs.set("r-branches", {
      id: "r-branches",
      rootNodeId: "fork:1",
      label: "Three-Lens Code Review",
      status: "running",
      startedAt: now,
      depth: 0,
      flow,
      cwd: "/tmp",
      scope: "both",
    });
    runtimeState.nodes.set("fork:1", {
      id: "fork:1",
      runId: "r-branches",
      specId: "fanout",
      specPath: "flow",
      kind: "fork",
      label: "Three-Lens Code Review",
      status: "waiting",
      startedAt: now,
    });
    runtimeState.nodes.set("branch:1", {
      id: "branch:1",
      runId: "r-branches",
      specPath: 'flow.branches["code_quality_and_docs"]',
      kind: "spawn",
      status: "running",
      branchKey: "code_quality_and_docs",
      startedAt: now,
    });
    runtimeState.nodes.set("branch:2", {
      id: "branch:2",
      runId: "r-branches",
      specPath: 'flow.branches["performance_and_architecture"]',
      kind: "spawn",
      status: "running",
      branchKey: "performance_and_architecture",
      startedAt: now,
    });
    runtimeState.nodes.set("branch:3", {
      id: "branch:3",
      runId: "r-branches",
      specPath: 'flow.branches["security_and_safety"]',
      kind: "spawn",
      status: "running",
      branchKey: "security_and_safety",
      startedAt: now,
    });
    runtimeState.order.push("r-branches");

    const lines = formatFlowTree(flow, runtimeState, "r-branches");

    expect(lines).toEqual([
      "◌ Three-Lens Code Review",
      "├─ code_quality_and_docs → ⠹ worker",
      "├─ performance_and_architecture → ⠹ worker",
      "└─ security_and_safety → ⠹ worker",
    ]);
  });
});
