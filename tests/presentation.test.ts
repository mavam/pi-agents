import { describe, expect, it } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  renderActiveRunWidgetLines,
  renderAgentCall,
  renderWorkflowResult,
} from "../extensions/agent/presentation.ts";
import { createRunRuntimeState } from "../extensions/agent/state.ts";
import type { RunResultDetails } from "../extensions/agent/types.ts";

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

  it("renders the runs widget without duplicate spinner rows for a single spawn", () => {
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
        agent: "explorer",
        task: "find files",
      },
      cwd: "/tmp",
      scope: "both",
    });
    runtimeState.nodes.set("root:1", {
      id: "root:1",
      runId: "run-1",
      kind: "spawn",
      label: "explorer",
      status: "running",
      startedAt,
    });
    runtimeState.order.push("run-1");

    const lines = renderActiveRunWidgetLines(runtimeState);

    expect(lines).toEqual(["● runs", "└─ ● explorer run-1 running"]);
  });
});
