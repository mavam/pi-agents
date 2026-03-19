import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  buildAgentsPrompt,
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
  type Scope,
} from "../catalog/agents.js";
import { toDiagnosticText } from "../catalog/diagnostics.js";
import { DelegatedAgentRunError } from "../engine/subprocess.js";
import { RunExecutionError } from "../runtime/executor.js";
import type {
  AgentRunDetails,
  RunResultDetails,
  WorkflowParams,
} from "../runtime/types.js";
import {
  AgentParamsSchema,
  type ToolPromptMetadata,
  UnknownAgentError,
  WorkflowParamsSchema,
} from "../tools/definitions.js";
import {
  formatAgentResultXml,
  formatWorkflowResultXml,
  getRootSpawnResult,
  renderAgentCall,
  renderAgentResult,
  renderWorkflowCall,
  renderWorkflowResult,
} from "../ui/presentation.js";
import { normalizeWorkflowParams } from "../workflow/flow-spec.js";
import { getCurrentModelId } from "./context.js";
import type { ManagedWorkflowExecutor } from "./managed-workflow.js";
import {
  formatBackgroundContinuationText,
  formatWorkflowProgressText,
  getRootRunNode,
  initialAgentDetails,
  mergeAgentProgressDetails,
} from "./tool-helpers.js";

export function buildAgentSystemPrompt(cwd: string): string {
  const { prompt: agentsPrompt } = buildAgentsPrompt(cwd, "both");
  return agentsPrompt;
}

export function createAgentTool(options: {
  pi: ExtensionAPI;
  executeManagedWorkflow: ManagedWorkflowExecutor;
}): ToolDefinition<typeof AgentParamsSchema, AgentRunDetails> &
  ToolPromptMetadata {
  const { pi, executeManagedWorkflow } = options;

  return {
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
      renderAgentResult(result, options.expanded, options.isPartial, theme),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
        const baseDetails: AgentRunDetails = {
          ...initialAgentDetails(scope, agent.name),
          agentSource: agent.source,
          model: agent.model ?? getCurrentModelId(ctx),
          thinking: agent.thinking,
          skills: [...agent.skills],
          discoveryDiagnostics: diagnostics,
          scope,
        };
        const details = await executeManagedWorkflow(
          workflow,
          ctx,
          signal,
          ctx.hasUI
            ? undefined
            : onUpdate
              ? (update) => {
                  const rootNode = getRootRunNode(update.details);
                  onUpdate({
                    content: [
                      {
                        type: "text",
                        text:
                          rootNode?.progress?.text ??
                          rootNode?.progress?.preview ??
                          formatWorkflowProgressText(update.details),
                      },
                    ],
                    details: mergeAgentProgressDetails(
                      update.details,
                      baseDetails,
                    ),
                  });
                }
              : undefined,
          {
            model: getCurrentModelId(ctx),
            thinking: pi.getThinkingLevel(),
          },
          { backgroundImmediately: ctx.hasUI },
        );
        const spawnResult = getRootSpawnResult(details);
        if (!spawnResult || details.run.status === "running") {
          return {
            content: [
              {
                type: "text",
                text: formatBackgroundContinuationText(details.run.id),
              },
            ],
            details: {
              ...mergeAgentProgressDetails(details, baseDetails),
              status: "background",
              stopReason: "background",
            },
            stopAgent: true,
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
          details: mergeAgentProgressDetails(details, spawnResult.run),
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
}

export function createWorkflowTool(options: {
  pi: ExtensionAPI;
  executeManagedWorkflow: ManagedWorkflowExecutor;
}): ToolDefinition<typeof WorkflowParamsSchema, RunResultDetails> &
  ToolPromptMetadata {
  const { pi, executeManagedWorkflow } = options;

  return {
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
      renderWorkflowResult(result, options.expanded, options.isPartial, theme),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workflowParams = normalizeWorkflowParams(params);
      const details = await executeManagedWorkflow(
        workflowParams,
        ctx,
        signal,
        ctx.hasUI ? undefined : onUpdate,
        {
          model: getCurrentModelId(ctx),
          thinking: pi.getThinkingLevel(),
        },
        { backgroundImmediately: ctx.hasUI },
      );
      return {
        content: [
          {
            type: "text",
            text:
              details.run.status === "running"
                ? formatBackgroundContinuationText(details.run.id)
                : formatWorkflowResultXml(details.result, details.run.id),
          },
        ],
        details,
        ...(details.run.status === "running" ? { stopAgent: true } : {}),
      };
    },
  };
}
