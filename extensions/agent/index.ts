import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { discoverAgents, formatAgentList, type Scope } from "./agents.js";
import { toDiagnosticText } from "./diagnostics.js";
import {
  createSubprocessSpawnEngine,
  DelegatedAgentRunError,
  formatFailureReason,
  isChildProcessRunning,
  type SpawnProcess,
} from "./engine/subprocess.js";
import { RunExecutionError, RunExecutor } from "./executor.js";
import { validateWorkflowParams } from "./flow-spec.js";
import { AgentManager } from "./manager.js";
import { RUN_EVENT_CUSTOM_TYPE } from "./persistence.js";
import {
  formatAgentDetails,
  formatAgentsOverview,
  formatOutput,
  formatRunDetailsText,
  formatRunOverviewText,
  getRootSpawnResult,
  rebuildRuntimeState,
  renderAgentCall,
  renderAgentResult,
  renderWorkflowCall,
  renderWorkflowResult,
  updateRunUI,
} from "./presentation.js";
import { createRunRuntimeState, getOrderedRuns } from "./state.js";
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
    const executor = new RunExecutor({
      pi,
      manager,
      runtimeState,
      onStateChanged: (ctx) => updateRunUI(ctx, runtimeState),
    });

    const reloadRunState = (_event: unknown, ctx: ExtensionContext) => {
      rebuildRuntimeState(runtimeState, ctx);
      updateRunUI(ctx, runtimeState);
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
        const agent = discovery.agents.find((a) => a.name === params.name);

        if (!agent) {
          const available = formatAgentList(discovery.agents);
          const message = `Unknown agent "${params.name}". Available: ${available}`;
          throw new UnknownAgentError(message, {
            ...initialAgentDetails(scope, params.name),
            discoveryDiagnostics: diagnostics,
          });
        }

        const workflow: WorkflowParams = {
          label: agent.name,
          cwd: effectiveCwd,
          scope,
          flow: {
            kind: "spawn",
            id: params.name,
            label: agent.name,
            agent: params.name,
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
              { type: "text", text: spawnResult.text || "(no output)" },
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
        validateWorkflowParams(params);
        const workflowParams = params as WorkflowParams;

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
                text: details.result
                  ? formatOutput(details.result.output)
                  : `Run ${details.run.id} completed.`,
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
