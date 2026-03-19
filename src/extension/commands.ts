import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
  discoverAgents,
  formatAgentList,
  type Scope,
} from "../catalog/agents.js";
import { toDiagnosticText } from "../catalog/diagnostics.js";
import type { LiveRunRegistry } from "../runtime/live-runs.js";
import { RUN_EVENT_CUSTOM_TYPE } from "../runtime/persistence.js";
import { getOrderedRuns, type RunRuntimeState } from "../runtime/state.js";
import {
  type FlowAction,
  hasRunnableFlows,
  pickFlowAction,
  watchFlow,
} from "../ui/flow-ui.js";
import {
  formatAgentDetails,
  formatAgentsOverview,
  formatFlowDiagramOutput,
  formatFlowInspectText,
  formatFlowMermaidOutput,
  formatFlowOverviewText,
  formatRunStatus,
  resolveFlowId,
} from "../ui/presentation.js";

function parseFlowCommand(args: string): { action: FlowAction; query: string } {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase();
  if (
    action === "watch" ||
    action === "mermaid" ||
    action === "diagram" ||
    action === "stop"
  ) {
    return { action, query: parts.slice(1).join(" ") };
  }
  return { action: "inspect", query: trimmed };
}

function formatFlowUsage(action: FlowAction): string {
  switch (action) {
    case "inspect":
      return "Usage: /flow <id-or-prefix>\n       /flow\n       /flows";
    case "watch":
      return "Usage: /flow watch <id-or-prefix>";
    case "mermaid":
      return "Usage: /flow mermaid <id-or-prefix>";
    case "diagram":
      return "Usage: /flow diagram <id-or-prefix>";
    case "stop":
      return "Usage: /flow stop <id-or-prefix>";
  }
}

export function registerAgentCommands(pi: ExtensionAPI): void {
  const sendAgentsMessage = (content: string): void => {
    pi.sendMessage({
      customType: "agents",
      content,
      display: true,
    });
  };

  pi.registerCommand("agents", {
    description: "List available agents",
    handler: async (args, ctx) => {
      const scope: Scope = "both";
      const discovery = discoverAgents(ctx.cwd, scope);
      const diagnostics = toDiagnosticText(scope, discovery.diagnostics);
      const query = args.trim();
      const content = query
        ? `Did you mean /agent ${query}? Use /agent <name> for full details.`
        : formatAgentsOverview(scope, discovery.agents, diagnostics);

      sendAgentsMessage(content);
    },
  });

  pi.registerCommand("agent", {
    description: "Show details for a specific agent",
    getArgumentCompletions: (prefix) => {
      const discovery = discoverAgents(process.cwd(), "both");
      const items = discovery.agents
        .filter((agent) => agent.name.startsWith(prefix))
        .map((agent) => ({
          value: agent.name,
          label: agent.name,
          description: `${agent.source}: ${agent.description}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const scope: Scope = "both";
      const query = args.trim();
      const discovery = discoverAgents(ctx.cwd, scope);
      const diagnostics = toDiagnosticText(scope, discovery.diagnostics);

      if (!query) {
        sendAgentsMessage("Usage: /agent <name>");
        return;
      }

      const agent = discovery.agents.find(
        (candidate) => candidate.name === query,
      );
      if (!agent) {
        sendAgentsMessage(
          `Unknown agent "${query}". Available: ${formatAgentList(discovery.agents)}`,
        );
        return;
      }

      sendAgentsMessage(formatAgentDetails(scope, agent, diagnostics));
    },
  });
}

export function registerFlowCommands(
  pi: ExtensionAPI,
  runtimeState: RunRuntimeState,
  liveRuns: LiveRunRegistry,
): void {
  const sendFlowMessage = (content: string): void => {
    pi.sendMessage({
      customType: RUN_EVENT_CUSTOM_TYPE,
      content,
      display: true,
    });
  };

  const stopFlow = (query: string): string => {
    const resolved = resolveFlowId(runtimeState, query);
    if ("error" in resolved) {
      return query.trim() ? resolved.error : formatFlowUsage("stop");
    }
    if (!liveRuns.has(resolved.runId)) {
      return `Flow ${resolved.runId} is not currently running.`;
    }
    liveRuns.stop(resolved.runId);
    return `Stopping flow ${resolved.runId}.`;
  };

  const showFlowsMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const runs = getOrderedRuns(runtimeState);
    if (runs.length === 0) {
      sendFlowMessage("No flows recorded in this session.");
      return;
    }

    const options = runs.slice(0, 20).map((run) => ({
      runId: run.id,
      label: `${run.label} · ${run.id.slice(0, 8)} · ${run.status}${run.backgroundedAt ? " (background)" : ""}`,
    }));
    const choice = await ctx.ui.select(
      "Flows",
      options.map((option) => option.label),
    );
    if (!choice) return;

    const selected = options.find((option) => option.label === choice);
    if (!selected) return;

    const run = runtimeState.runs.get(selected.runId);
    if (!run) return;

    const actions = [
      "Inspect",
      ...(liveRuns.has(run.id) ? ["Watch"] : []),
      "Diagram",
      "Mermaid",
      ...(run.status === "running" && liveRuns.has(run.id) ? ["Stop"] : []),
      "Back",
    ];
    const action = await ctx.ui.select(run.label, actions);
    if (!action || action === "Back") return;

    if (action === "Inspect") {
      sendFlowMessage(formatFlowInspectText(runtimeState, run.id));
    } else if (action === "Watch") {
      await watchFlow(ctx, runtimeState, liveRuns, run.id);
    } else if (action === "Diagram") {
      sendFlowMessage(formatFlowDiagramOutput(runtimeState, run.id));
    } else if (action === "Mermaid") {
      sendFlowMessage(formatFlowMermaidOutput(runtimeState, run.id));
    } else if (action === "Stop") {
      sendFlowMessage(stopFlow(run.id));
    }

    await showFlowsMenu(ctx);
  };

  pi.registerCommand("flows", {
    description: "List recorded flows",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query && ctx.hasUI) {
        await showFlowsMenu(ctx as ExtensionCommandContext);
        return;
      }
      const content = query
        ? `Did you mean /flow ${query}? Use /flow <id> to inspect a flow.`
        : formatFlowOverviewText(runtimeState);
      sendFlowMessage(content);
    },
  });

  pi.registerCommand("flow", {
    description: "Inspect, watch, render, and stop flows",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase();
      const query =
        action === "watch" ||
        action === "mermaid" ||
        action === "diagram" ||
        action === "stop"
          ? parts.slice(1).join(" ")
          : trimmed;
      const valuePrefix =
        action === "watch" ||
        action === "mermaid" ||
        action === "diagram" ||
        action === "stop"
          ? `${action} `
          : "";
      const items = getOrderedRuns(runtimeState)
        .map((run) => ({
          value: `${valuePrefix}${run.id}`,
          label: run.label,
          description: `${formatRunStatus(run)} · ${run.id.slice(0, 8)}`,
        }))
        .filter(
          (item) =>
            item.value.startsWith(trimmed) ||
            item.value.startsWith(`${valuePrefix}${query}`) ||
            item.label.startsWith(query),
        );
      if (items.length > 0) return items;
      if (parts.length <= 1) {
        return [
          { value: "watch ", label: "watch", description: "Live watch mode" },
          {
            value: "diagram ",
            label: "diagram",
            description: "Render Unicode diagram in terminal",
          },
          {
            value: "mermaid ",
            label: "mermaid",
            description: "Render Mermaid source",
          },
          {
            value: "stop ",
            label: "stop",
            description: "Stop a running flow",
          },
        ].filter(
          (item) =>
            item.value.startsWith(trimmed) || item.label.startsWith(trimmed),
        );
      }
      return null;
    },
    handler: async (args, ctx) => {
      const parsed = parseFlowCommand(args);
      let action = parsed.action;
      let runId = parsed.query;

      if (!runId && ctx.hasUI) {
        const hasCandidates =
          action === "watch" || action === "stop"
            ? hasRunnableFlows(runtimeState, liveRuns)
            : getOrderedRuns(runtimeState).length > 0;
        if (!hasCandidates) {
          sendFlowMessage(
            action === "watch" || action === "stop"
              ? "No running flows available."
              : "No flows recorded in this session.",
          );
          return;
        }
        const selection = await pickFlowAction(
          ctx as ExtensionCommandContext,
          runtimeState,
          liveRuns,
          action,
        );
        if (!selection) return;
        action = selection.action;
        runId = selection.runId;
      }

      if (!runId) {
        sendFlowMessage(formatFlowUsage(action));
        return;
      }

      if (action === "watch") {
        if (!ctx.hasUI) {
          sendFlowMessage("`/flow watch` requires interactive mode.");
          return;
        }
        await watchFlow(
          ctx as ExtensionCommandContext,
          runtimeState,
          liveRuns,
          runId,
        );
        return;
      }

      const content =
        action === "stop"
          ? stopFlow(runId)
          : action === "diagram"
            ? formatFlowDiagramOutput(runtimeState, runId)
            : action === "mermaid"
              ? formatFlowMermaidOutput(runtimeState, runId)
              : formatFlowInspectText(runtimeState, runId);
      sendFlowMessage(content);
    },
  });
}
