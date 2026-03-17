import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
  type Scope,
  type Thinking,
} from "./agents.js";
import { toDiagnosticText } from "./diagnostics.js";
import {
  createSubprocessSpawnEngine,
  DelegatedAgentRunError,
  formatFailureReason,
  isChildProcessRunning,
  type SpawnProcess,
} from "./engine/subprocess.js";
import { AgentEvents } from "./events.js";
import { RunExecutionError, RunExecutor } from "./executor.js";
import { normalizeWorkflowParams } from "./flow-spec.js";
import {
  type FlowAction,
  hasRunnableFlows,
  pickFlowAction,
  watchFlow,
} from "./flow-ui.js";
import { LiveRunRegistry } from "./live-runs.js";
import { AgentManager } from "./manager.js";
import { RUN_EVENT_CUSTOM_TYPE } from "./persistence.js";
import {
  formatAgentDetails,
  formatAgentResultXml,
  formatAgentsOverview,
  formatFlowInspectText,
  formatFlowMermaidOutput,
  formatFlowOverviewText,
  formatRunStatus,
  formatWorkflowResultXml,
  getRootSpawnResult,
  RunWidgetManager,
  rebuildRuntimeState,
  renderAgentCall,
  renderAgentResult,
  renderWorkflowCall,
  renderWorkflowResult,
  resolveFlowId,
} from "./presentation.js";
import { RunEventCache } from "./session-events.js";
import {
  countStatuses,
  createRunRuntimeState,
  getOrderedRuns,
  getRunSnapshot,
} from "./state.js";
import {
  AgentParamsSchema,
  type ToolPromptMetadata,
  UnknownAgentError,
  WorkflowParamsSchema,
} from "./tool-definitions.js";
import type {
  AgentRunDetails,
  RunEvent,
  RunResultDetails,
  WorkflowParams,
} from "./types.js";
import {
  formatWorkflowAgentsXml,
  shouldInjectWorkflowAgentsPrompt,
} from "./workflow-agent-prompt.js";

function initialAgentDetails(scope: Scope, agent: string): AgentRunDetails {
  return {
    agent,
    agentSource: "unknown",
    skills: [],
    missingSkills: [],
    exitCode: 1,
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    discoveryDiagnostics: [],
    scope,
  };
}

function getCurrentModelId(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function formatDetachedToolText(runId: string): string {
  return `Flow detached: ${runId}\nUse /flow watch ${runId} to re-enter live mode, /flow ${runId} to inspect, or /flow stop ${runId} to stop it.`;
}

function parseFlowCommand(args: string): { action: FlowAction; query: string } {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase();
  if (action === "watch" || action === "mermaid" || action === "stop") {
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
    case "stop":
      return "Usage: /flow stop <id-or-prefix>";
  }
}

export function createAgentExtension(options?: {
  spawnProcess?: SpawnProcess;
}) {
  const engine = createSubprocessSpawnEngine({
    spawnProcess: options?.spawnProcess,
  });

  return function agentExtension(pi: ExtensionAPI) {
    const runtimeState = createRunRuntimeState();
    const manager = new AgentManager(engine);
    const liveRuns = new LiveRunRegistry();
    const runEventCache = new RunEventCache();
    const widgetManager = new RunWidgetManager(runtimeState);
    let workflowUsedInCurrentAgentRun = false;
    let workflowUsedInPreviousAgentRun = false;
    const executor = new RunExecutor({
      pi,
      manager,
      runtimeState,
      onStateChanged: (ctx) => {
        widgetManager.update(ctx);
        pi.events.emit(
          AgentEvents.RUN_COUNTS_CHANGED,
          countStatuses(runtimeState),
        );
      },
    });

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

    const sendFlowMessage = (content: string): void => {
      pi.sendMessage({
        customType: RUN_EVENT_CUSTOM_TYPE,
        content,
        display: true,
      });
    };

    const showFlowsMenu = async (
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const runs = getOrderedRuns(runtimeState);
      if (runs.length === 0) {
        sendFlowMessage("No flows recorded in this session.");
        return;
      }

      const options = runs.slice(0, 20).map((run) => ({
        runId: run.id,
        label: `${run.label} · ${run.id.slice(0, 8)} · ${run.status}${run.detachedAt ? " (detached)" : ""}`,
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
      } else if (action === "Mermaid") {
        sendFlowMessage(formatFlowMermaidOutput(runtimeState, run.id));
      } else if (action === "Stop") {
        sendFlowMessage(stopFlow(run.id));
      }

      await showFlowsMenu(ctx);
    };

    const executeManagedWorkflow = async (
      workflowParams: WorkflowParams,
      ctx: ExtensionContext,
      signal: AbortSignal | undefined,
      onUpdate:
        | ((result: AgentToolResult<RunResultDetails>) => void)
        | undefined,
      defaults: { model?: string; thinking?: Thinking },
    ): Promise<RunResultDetails> => {
      if (signal?.aborted) {
        return await executor.execute(
          workflowParams,
          ctx,
          signal,
          onUpdate,
          defaults,
        );
      }

      const backgroundController = new AbortController();
      const origin = runEventCache.createOrigin(
        (ctx as ExtensionContext).sessionManager,
      );
      let runId: string | undefined;
      let detached = false;
      let settled = false;
      let resolveDetach: ((details: RunResultDetails) => void) | undefined;
      let rejectDetach: ((error: Error) => void) | undefined;

      const detachPromise = new Promise<RunResultDetails>((resolve, reject) => {
        resolveDetach = resolve;
        rejectDetach = reject;
      });
      const persistEvent = (event: RunEvent) => {
        if (!runEventCache.appendToOrigin(origin, event)) {
          pi.appendEntry(RUN_EVENT_CUSTOM_TYPE, event);
        }
      };

      const onAbort = () => {
        if (settled) return;
        if (!runId) {
          backgroundController.abort();
          rejectDetach?.(new Error("Workflow aborted."));
          return;
        }
        detached = true;
        executor.markDetached(runId, ctx, {
          appendEvent: persistEvent,
        });
        const snapshot = getRunSnapshot(runtimeState, runId);
        if (snapshot) {
          resolveDetach?.(snapshot);
        } else {
          rejectDetach?.(new Error("Workflow aborted."));
        }
      };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const executionPromise = executor
        .execute(
          workflowParams,
          ctx,
          backgroundController.signal,
          detached
            ? undefined
            : onUpdate
              ? (update) => {
                  if (!detached) onUpdate(update);
                }
              : undefined,
          defaults,
          {
            appendEvent: persistEvent,
            onRunCreated: (createdRunId) => {
              runId = createdRunId;
              liveRuns.register({
                runId: createdRunId,
                sessionFile: origin.sessionFile,
                stop: () => backgroundController.abort(),
                snapshot: () => getRunSnapshot(runtimeState, createdRunId),
              });
            },
          },
        )
        .finally(() => {
          settled = true;
          if (runId) liveRuns.remove(runId);
        });

      try {
        return await Promise.race([executionPromise, detachPromise]);
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    };

    const reloadRunState = (_event: unknown, ctx: ExtensionContext) => {
      rebuildRuntimeState(runtimeState, ctx, runEventCache, liveRuns);
      widgetManager.update(ctx);
    };

    pi.on("session_start", async (event, ctx) => {
      reloadRunState(event, ctx);
    });
    pi.on("session_switch", async (event, ctx) => {
      reloadRunState(event, ctx);
    });
    pi.on("session_fork", async (event, ctx) => {
      reloadRunState(event, ctx);
    });
    pi.on("session_tree", async (event, ctx) => {
      reloadRunState(event, ctx);
    });
    pi.on("session_shutdown", async () => {
      liveRuns.stopAll();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (
        !shouldInjectWorkflowAgentsPrompt(event.prompt, {
          workflowUsedInPreviousTurn: workflowUsedInPreviousAgentRun,
        })
      ) {
        return undefined;
      }

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Workflow agent catalog\n\n${formatWorkflowAgentsXml(ctx.cwd, "both")}`,
      };
    });

    pi.on("agent_start", async () => {
      workflowUsedInCurrentAgentRun = false;
    });

    pi.on("tool_execution_end", async (event) => {
      if (event.toolName === "workflow") {
        workflowUsedInCurrentAgentRun = true;
      }
    });

    pi.on("agent_end", async () => {
      workflowUsedInPreviousAgentRun = workflowUsedInCurrentAgentRun;
    });

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

        pi.sendMessage({
          customType: "agents",
          content,
          display: true,
        });
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
          pi.sendMessage({
            customType: "agents",
            content: "Usage: /agent <name>",
            display: true,
          });
          return;
        }

        const agent = discovery.agents.find((a) => a.name === query);
        if (!agent) {
          pi.sendMessage({
            customType: "agents",
            content: `Unknown agent "${query}". Available: ${formatAgentList(discovery.agents)}`,
            display: true,
          });
          return;
        }

        pi.sendMessage({
          customType: "agents",
          content: formatAgentDetails(scope, agent, diagnostics),
          display: true,
        });
      },
    });

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
          action === "watch" || action === "mermaid" || action === "stop"
            ? parts.slice(1).join(" ")
            : trimmed;
        const valuePrefix =
          action === "watch" || action === "mermaid" || action === "stop"
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
              value: "mermaid ",
              label: "mermaid",
              description: "Render Mermaid output",
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
            : action === "mermaid"
              ? formatFlowMermaidOutput(runtimeState, runId)
              : formatFlowInspectText(runtimeState, runId);
        sendFlowMessage(content);
      },
    });

    const agentTool: ToolDefinition<typeof AgentParamsSchema, AgentRunDetails> &
      ToolPromptMetadata = {
      name: "agent",
      label: "Agent",
      description:
        "Run an isolated pi agent from an agent markdown definition (name, description, model, thinking, skills).",
      promptSnippet:
        "Delegate a focused subtask to a named agent definition in an isolated pi subprocess.",
      promptGuidelines: [
        "Use agent for a single delegated subtask handled by one named agent.",
        "Prefer workflow instead when you need sequencing, branching, joins, or loops across multiple agents.",
      ],
      parameters: AgentParamsSchema,
      renderCall: (args, theme) => renderAgentCall(args, theme),
      renderResult: (result, options, theme) =>
        renderAgentResult(result, options.expanded, theme),
      async execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ): Promise<AgentToolResult<AgentRunDetails>> {
        const scope: Scope = params.scope ?? "both";
        const effectiveCwd = params.cwd ?? ctx.cwd;
        const discovery = discoverAgents(effectiveCwd, scope);
        const diagnostics = toDiagnosticText(scope, discovery.diagnostics);
        const resolvedAgent = resolveAgentByName(discovery.agents, params.name);

        if (resolvedAgent.kind === "missing") {
          const available = formatAgentList(discovery.agents);
          const message = `Unknown agent "${params.name}". Available: ${available}`;
          throw new UnknownAgentError(message, {
            ...initialAgentDetails(scope, params.name),
            discoveryDiagnostics: diagnostics,
          });
        }
        if (resolvedAgent.kind === "ambiguous") {
          const message = `Agent name "${params.name}" is ambiguous ignoring case. Matches: ${formatAgentList(resolvedAgent.matches)}`;
          throw new UnknownAgentError(message, {
            ...initialAgentDetails(scope, params.name),
            discoveryDiagnostics: diagnostics,
          });
        }
        const agent = resolvedAgent.agent;

        const workflow: WorkflowParams = {
          label: agent.name,
          cwd: effectiveCwd,
          scope,
          flow: {
            kind: "spawn",
            id: agent.name,
            label: agent.name,
            agent: agent.name,
            task: params.task,
          },
        };

        try {
          const details = await executeManagedWorkflow(
            workflow,
            ctx,
            signal,
            onUpdate
              ? (update) => {
                  const spawnResult = getRootSpawnResult(update.details);
                  if (!spawnResult) return;
                  onUpdate({
                    content: [
                      {
                        type: "text",
                        text: spawnResult.text || "(no output)",
                      },
                    ],
                    details: spawnResult.run,
                  });
                }
              : undefined,
            {
              model: getCurrentModelId(ctx),
              thinking: pi.getThinkingLevel(),
            },
          );
          const spawnResult = getRootSpawnResult(details);
          if (!spawnResult || details.run.status === "running") {
            return {
              content: [
                {
                  type: "text",
                  text: formatDetachedToolText(details.run.id),
                },
              ],
              details: {
                agent: agent.name,
                agentSource: agent.source,
                model: agent.model ?? getCurrentModelId(ctx),
                thinking: agent.thinking,
                skills: [...agent.skills],
                missingSkills: [],
                exitCode: -1,
                stderr: "",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 0,
                  turns: 0,
                },
                discoveryDiagnostics: diagnostics,
                scope,
                stopReason: "detached",
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: formatAgentResultXml(
                  agent.name,
                  spawnResult.text || "(no output)",
                ),
              },
            ],
            details: spawnResult.run,
          };
        } catch (error) {
          if (
            error instanceof RunExecutionError &&
            error.cause instanceof DelegatedAgentRunError
          ) {
            throw error.cause;
          }
          throw error;
        }
      },
    };

    pi.registerTool(agentTool);

    const workflowTool: ToolDefinition<
      typeof WorkflowParamsSchema,
      RunResultDetails
    > &
      ToolPromptMetadata = {
      name: "workflow",
      label: "Flow",
      description:
        "Run an explicit, JSON-defined agent flow over isolated agent executions.",
      promptSnippet:
        "Run a structured multi-agent flow with sequencing, forks, joins, and loops.",
      promptGuidelines: [
        "Use workflow when you need orchestration across multiple agents or multiple execution steps.",
        "Prefer compact workflow syntax: spawn nodes may omit kind, and fork branches may use agent-name strings or spawn shorthands.",
        "When many branches share the same agent or task shape, use fork defaults such as agent and taskTemplate instead of repeating full spawn objects.",
        "If a workflow agent catalog is present in the prompt, treat it as authoritative and use only those exact agent names.",
        "Do not invent workflow agent names.",
        "Keep workflow definitions explicit and JSON-serializable.",
      ],
      parameters: WorkflowParamsSchema,
      renderCall: (args, theme) =>
        renderWorkflowCall(args as WorkflowParams, theme),
      renderResult: (result, options, theme) =>
        renderWorkflowResult(result, options.expanded, theme),
      async execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ): Promise<AgentToolResult<RunResultDetails>> {
        const workflowParams = normalizeWorkflowParams(params);

        try {
          const details = await executeManagedWorkflow(
            workflowParams,
            ctx,
            signal,
            onUpdate,
            {
              model: getCurrentModelId(ctx),
              thinking: pi.getThinkingLevel(),
            },
          );
          return {
            content: [
              {
                type: "text",
                text:
                  details.run.status === "running"
                    ? formatDetachedToolText(details.run.id)
                    : formatWorkflowResultXml(details.result, details.run.id),
              },
            ],
            details,
          };
        } catch (error) {
          if (error instanceof RunExecutionError) throw error;
          throw error;
        }
      },
    };

    pi.registerTool(workflowTool);
  };
}

export default createAgentExtension();
export * from "./events.js";
export { formatFailureReason, isChildProcessRunning, type SpawnProcess };
