import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
  type Scope,
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
import { AgentManager } from "./manager.js";
import { RUN_EVENT_CUSTOM_TYPE } from "./persistence.js";
import {
  formatAgentDetails,
  formatAgentResultXml,
  formatAgentsOverview,
  formatFlowCommandOutput,
  formatOutput,
  formatRunDetailsText,
  formatRunOverviewText,
  formatWorkflowResultXml,
  getRootSpawnResult,
  RunWidgetManager,
  rebuildRuntimeState,
  renderAgentCall,
  renderAgentResult,
  renderWorkflowCall,
  renderWorkflowResult,
} from "./presentation.js";
import {
  countStatuses,
  createRunRuntimeState,
  getOrderedRuns,
} from "./state.js";
import {
  AgentParamsSchema,
  type ToolPromptMetadata,
  UnknownAgentError,
  WorkflowParamsSchema,
} from "./tool-definitions.js";
import type {
  AgentRunDetails,
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

export function createAgentExtension(options?: {
  spawnProcess?: SpawnProcess;
}) {
  const engine = createSubprocessSpawnEngine({
    spawnProcess: options?.spawnProcess,
  });

  return function agentExtension(pi: ExtensionAPI) {
    const runtimeState = createRunRuntimeState();
    const manager = new AgentManager(engine);
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

    const reloadRunState = (_event: unknown, ctx: ExtensionContext) => {
      rebuildRuntimeState(runtimeState, ctx);
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

    pi.registerCommand("runs", {
      description: "List agent runs",
      handler: async (args) => {
        const query = args.trim();
        const content = query
          ? `Did you mean /run ${query}? Use /run <id> for full details.`
          : formatRunOverviewText(runtimeState);
        pi.sendMessage({
          customType: RUN_EVENT_CUSTOM_TYPE,
          content,
          display: true,
        });
      },
    });

    pi.registerCommand("run", {
      description: "Show details for a specific run",
      getArgumentCompletions: (prefix) => {
        const items = getOrderedRuns(runtimeState)
          .map((run) => ({
            value: run.id,
            label: run.label,
            description: `${run.status} · ${run.id.slice(0, 8)}`,
          }))
          .filter(
            (item) =>
              item.value.startsWith(prefix) || item.label.startsWith(prefix),
          );
        return items.length > 0 ? items : null;
      },
      handler: async (args) => {
        const query = args.trim();
        const content = query
          ? formatRunDetailsText(runtimeState, query)
          : "Usage: /run <id-or-prefix>";
        pi.sendMessage({
          customType: RUN_EVENT_CUSTOM_TYPE,
          content,
          display: true,
        });
      },
    });

    pi.registerCommand("flow", {
      description:
        "Show the flow tree for a run (use 'mermaid' suffix for Mermaid output)",
      getArgumentCompletions: (prefix) => {
        const items = getOrderedRuns(runtimeState)
          .map((run) => ({
            value: run.id,
            label: run.label,
            description: `${run.status} · ${run.id.slice(0, 8)}`,
          }))
          .filter(
            (item) =>
              item.value.startsWith(prefix) || item.label.startsWith(prefix),
          );
        return items.length > 0 ? items : null;
      },
      handler: async (args) => {
        const content = formatFlowCommandOutput(runtimeState, args);
        pi.sendMessage({
          customType: RUN_EVENT_CUSTOM_TYPE,
          content,
          display: true,
        });
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
          const details = await executor.execute(
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
          if (!spawnResult) {
            throw new Error(
              "Expected single-agent workflow to return a spawn result.",
            );
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
      label: "Workflow",
      description:
        "Run an explicit, JSON-defined agent workflow over isolated agent runs.",
      promptSnippet:
        "Run a structured multi-agent workflow with sequencing, forks, joins, and loops.",
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
          const details = await executor.execute(
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
                text: formatWorkflowResultXml(details.result, details.run.id),
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
