import { StringEnum } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type Agent,
  discoverAgents,
  formatAgentList,
  type Scope,
} from "./agents.js";
import {
  createSubprocessSpawnEngine,
  formatFailureReason,
  isChildProcessRunning,
  type SpawnProcess,
} from "./engine/subprocess.js";
import { CompositionExecutionError, CompositionExecutor } from "./executor.js";
import { validateComposeParams } from "./flow-spec.js";
import { AgentManager } from "./manager.js";
import {
  COMPOSITION_EVENT_CUSTOM_TYPE,
  rebuildCompositionState,
} from "./persistence.js";
import {
  countStatuses,
  createCompositionRuntimeState,
  getCompositionNodes,
  getOrderedCompositions,
  iconForStatus,
  markRunningCompositionsAborted,
} from "./state.js";
import type {
  AgentRunDetails,
  ComposeParams,
  CompositionResultDetails,
} from "./types.js";

interface AgentToolExecutionResult<T> extends AgentToolResult<T> {
  isError?: boolean;
}

const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agents to load. "user" reads ~/.pi/agents. "project" reads nearest .pi/agents. "both" merges both (project wins).',
  default: "both",
});

const AgentParamsSchema = Type.Object({
  name: Type.String({
    description: "Name of the agent definition from markdown frontmatter",
  }),
  task: Type.String({ description: "Task to delegate" }),
  scope: Type.Optional(ScopeSchema),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the delegated agent process",
    }),
  ),
});

const WorkflowParamsSchema = Type.Object({
  label: Type.Optional(
    Type.String({ description: "Optional label shown in workflow UI" }),
  ),
  flow: Type.Any({
    description:
      "Serializable FlowSpec: spawn | sequence | fork | join | loop.",
  }),
  budgets: Type.Optional(
    Type.Object({
      maxDepth: Type.Optional(Type.Number()),
      maxChildren: Type.Optional(Type.Number()),
      maxParallelism: Type.Optional(Type.Number()),
      maxIterations: Type.Optional(Type.Number()),
    }),
  ),
  scope: Type.Optional(ScopeSchema),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for relative agent discovery and tasks",
    }),
  ),
});

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

function toDiagnosticText(
  scope: Scope,
  diagnostics: Array<{ filePath: string; message: string }>,
): string[] {
  const prefix = `scope=${scope}`;
  return diagnostics.map((d) => `${prefix}: ${d.filePath}: ${d.message}`);
}

function formatAgentsOverview(
  scope: Scope,
  agents: Agent[],
  diagnostics: string[],
): string {
  if (agents.length === 0) {
    const parts = [
      `No agents found for scope=${scope}.`,
      "Expected locations:",
      "- ~/.pi/agents/*.md",
      "- nearest .pi/agents/*.md",
    ];
    if (diagnostics.length > 0) {
      parts.push("", "Diagnostics:", ...diagnostics.map((d) => `- ${d}`));
    }
    return parts.join("\n");
  }

  const lines = [`Available agents (${agents.length}) [scope=${scope}]:`];
  for (const agent of agents) {
    lines.push(`- ${agent.name} (${agent.source}) — ${agent.description}`);
  }
  lines.push("", "Use /agents <name> for full details.");
  if (diagnostics.length > 0) {
    lines.push("", "Diagnostics:", ...diagnostics.map((d) => `- ${d}`));
  }
  return lines.join("\n");
}

function formatAgentDetails(
  scope: Scope,
  agent: Agent,
  diagnostics: string[],
): string {
  const lines = [
    `Agent: ${agent.name}`,
    `Scope: ${scope}`,
    `Source: ${agent.source}`,
    `Path: ${agent.filePath}`,
    `Description: ${agent.description}`,
    `Model: ${agent.model ?? "(inherit from current session model)"}`,
    `Thinking: ${agent.thinking ?? "(inherit from current session setting)"}`,
    `Skills: ${agent.skills.length > 0 ? agent.skills.join(", ") : "(none)"}`,
    "",
    "System prompt:",
    agent.systemPrompt || "(empty)",
  ];

  if (diagnostics.length > 0) {
    lines.push("", "Diagnostics:", ...diagnostics.map((d) => `- ${d}`));
  }

  return lines.join("\n");
}

function formatRunOverviewText(
  runtimeState: ReturnType<typeof createCompositionRuntimeState>,
): string {
  const runs = getOrderedCompositions(runtimeState);
  if (runs.length === 0) {
    return "No runs recorded in this session.";
  }

  const lines = ["Runs:"];
  for (const run of runs.slice(0, 10)) {
    const nodes = getCompositionNodes(runtimeState, run.id);
    lines.push(
      `- ${iconForStatus(run.status)} ${run.label} (${run.id.slice(0, 8)}) · ${run.status} · ${nodes.length} nodes`,
    );
  }
  return lines.join("\n");
}

function resolveRunId(
  runtimeState: ReturnType<typeof createCompositionRuntimeState>,
  query: string,
):
  | { runId: string }
  | {
      error: string;
    } {
  const trimmed = query.trim();
  if (!trimmed) {
    return { error: "Run ID must not be empty." };
  }

  if (runtimeState.runs.has(trimmed)) {
    return { runId: trimmed };
  }

  const matches = getOrderedCompositions(runtimeState).filter((item) =>
    item.id.startsWith(trimmed),
  );
  if (matches.length === 1) {
    return { runId: matches[0]!.id };
  }

  if (matches.length > 1) {
    return {
      error: `Ambiguous run ID prefix "${trimmed}". Matches: ${matches
        .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
        .join(", ")}`,
    };
  }

  const known = getOrderedCompositions(runtimeState)
    .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
    .join(", ");
  return { error: `Unknown run "${trimmed}". Known: ${known || "none"}` };
}

function formatRunDetailsText(
  runtimeState: ReturnType<typeof createCompositionRuntimeState>,
  runId: string,
): string {
  const resolved = resolveRunId(runtimeState, runId);
  if ("error" in resolved) {
    return resolved.error;
  }

  const run = runtimeState.runs.get(resolved.runId);
  if (!run) {
    return `Unknown run "${runId}".`;
  }

  const nodes = getCompositionNodes(runtimeState, run.id);
  const lines = [
    `Run: ${run.label}`,
    `ID: ${run.id}`,
    `Status: ${run.status}`,
    `Scope: ${run.scope}`,
    `CWD: ${run.cwd}`,
    `Started: ${new Date(run.startedAt).toISOString()}`,
  ];
  if (run.completedAt) {
    lines.push(`Completed: ${new Date(run.completedAt).toISOString()}`);
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`);
  }
  lines.push("", "Nodes:");
  for (const node of nodes) {
    const suffix: string[] = [];
    if (node.branchKey) suffix.push(`branch=${node.branchKey}`);
    if (node.iteration !== undefined)
      suffix.push(`iteration=${node.iteration}`);
    if (node.specId) suffix.push(`spec=${node.specId}`);
    lines.push(
      `- ${iconForStatus(node.status)} ${node.kind} ${node.id}${suffix.length > 0 ? ` (${suffix.join(", ")})` : ""}`,
    );
    if (node.error) lines.push(`  error: ${node.error}`);
  }
  if (run.result) {
    lines.push("", "Result:", formatOutput(run.result.output));
  }
  return lines.join("\n");
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function updateRunUI(
  ctx: ExtensionContext | undefined,
  runtimeState: ReturnType<typeof createCompositionRuntimeState>,
): void {
  if (!ctx?.hasUI) return;
  const runs = getOrderedCompositions(runtimeState);
  const active = runs.filter((run) => run.status === "running");

  if (active.length === 0) {
    ctx.ui.setWidget("pi-agents-runs", undefined);
    ctx.ui.setStatus("pi-agents-runs", undefined);
    return;
  }

  const lines = ["● runs"];
  for (const run of active.slice(0, 5)) {
    const nodes = getCompositionNodes(runtimeState, run.id);
    const lastNodes = nodes.slice(-4);
    lines.push(
      `├─ ${iconForStatus(run.status)} ${run.label} ${run.id.slice(0, 8)} ${run.status}`,
    );
    for (const node of lastNodes) {
      const label = node.label ?? node.specId ?? node.kind;
      lines.push(`│  ├─ ${iconForStatus(node.status)} ${label}`);
    }
  }

  const counts = countStatuses(runtimeState);
  ctx.ui.setWidget("pi-agents-runs", lines);
  ctx.ui.setStatus(
    "pi-agents-runs",
    `${counts.compositions} runs · ${counts.running} agents running · ${counts.waiting} waiting nodes`,
  );
}

export function createAgentExtension(options?: {
  spawnProcess?: SpawnProcess;
}) {
  const engine = createSubprocessSpawnEngine({
    spawnProcess: options?.spawnProcess,
  });

  return function agentExtension(pi: ExtensionAPI) {
    const runtimeState = createCompositionRuntimeState();
    const manager = new AgentManager(engine);
    const executor = new CompositionExecutor({
      pi,
      manager,
      runtimeState,
      onStateChanged: (ctx) => updateRunUI(ctx, runtimeState),
    });

    if (typeof (pi as { on?: unknown }).on === "function") {
      pi.on("session_start", async (_event, ctx) => {
        const rebuilt = rebuildCompositionState(
          ctx.sessionManager.getEntries(),
        );
        runtimeState.runs.clear();
        runtimeState.nodes.clear();
        runtimeState.order.length = 0;
        for (const [id, run] of rebuilt.runs.entries())
          runtimeState.runs.set(id, run);
        for (const [id, node] of rebuilt.nodes.entries())
          runtimeState.nodes.set(id, node);
        runtimeState.order.push(...rebuilt.order);
        markRunningCompositionsAborted(runtimeState);
        updateRunUI(ctx, runtimeState);
      });
    }

    pi.registerCommand("agents", {
      description:
        "List available agents, or show details for a specific agent",
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
            content: formatAgentsOverview(scope, discovery.agents, diagnostics),
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
      description: "List agent runs, or show details for a specific run",
      getArgumentCompletions: (prefix) => {
        const items = getOrderedCompositions(runtimeState)
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
          : formatRunOverviewText(runtimeState);
        pi.sendMessage({
          customType: COMPOSITION_EVENT_CUSTOM_TYPE,
          content,
          display: true,
        });
      },
    });

    pi.registerTool({
      name: "agent",
      label: "Agent",
      description:
        "Run an isolated pi agent from an agent markdown definition (name, description, model, thinking, skills).",
      parameters: AgentParamsSchema,
      async execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ): Promise<AgentToolExecutionResult<AgentRunDetails>> {
        const scope: Scope = params.scope ?? "both";
        const discovery = discoverAgents(ctx.cwd, scope);
        const diagnostics = toDiagnosticText(scope, discovery.diagnostics);
        const agent = discovery.agents.find((a) => a.name === params.name);

        if (!agent) {
          const available = formatAgentList(discovery.agents);
          const message = `Unknown agent "${params.name}". Available: ${available}`;
          return {
            content: [{ type: "text", text: message }],
            details: {
              ...initialAgentDetails(scope, params.name),
              discoveryDiagnostics: diagnostics,
            },
            isError: true,
          };
        }

        const handle = manager.spawn(
          {
            agent,
            task: params.task,
            cwd: params.cwd ?? ctx.cwd,
            scope,
            discoveryDiagnostics: diagnostics,
          },
          ctx,
        );

        const onAbort = () => {
          void handle.abort();
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const updateTask = (async () => {
          if (!onUpdate) return;
          for await (const update of handle.updates) {
            onUpdate({
              content: [{ type: "text", text: update.text }],
              details: update.details,
            });
          }
        })();

        try {
          const result = await handle.wait();
          await updateTask;
          return {
            content: [{ type: "text", text: result.text || "(no output)" }],
            details: result.details,
          };
        } finally {
          if (signal) signal.removeEventListener("abort", onAbort);
        }
      },
    });

    pi.registerTool({
      name: "workflow",
      label: "Workflow",
      description:
        "Run an explicit, JSON-defined agent workflow over isolated agent runs.",
      parameters: WorkflowParamsSchema,
      async execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      ): Promise<AgentToolExecutionResult<CompositionResultDetails>> {
        validateComposeParams(params);
        const workflowParams = params as ComposeParams;

        try {
          const details = await executor.execute(
            workflowParams,
            ctx,
            signal,
            onUpdate,
          );
          return {
            content: [
              {
                type: "text",
                text: details.result
                  ? formatOutput(details.result.output)
                  : `Run ${details.composition.id} completed.`,
              },
            ],
            details,
          };
        } catch (error) {
          if (error instanceof CompositionExecutionError) throw error;
          throw error;
        }
      },
    });
  };
}

export default createAgentExtension();
export { formatFailureReason, isChildProcessRunning, type SpawnProcess };
