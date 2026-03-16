import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  buildWidgetLines,
  formatFlowTree,
  renderAgentCall,
  renderWorkflowResult,
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
    expect(lines[0]).toContain("Runs");
    expect(lines[1]).toContain("explorer");
    expect(lines[1]).toContain("run-1");
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
      kind: "spawn",
      status: "completed",
      startedAt: now,
      completedAt: now + 1,
    });
    runtimeState.nodes.set("n2", {
      id: "n2",
      runId: "r1",
      specId: "s2",
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
});
