import { StringEnum } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type Agent,
  discoverAgents,
  formatAgentList,
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
import { RunExecutionError, RunExecutor } from "./executor.js";
import { validateWorkflowParams } from "./flow-spec.js";
import { AgentManager } from "./manager.js";
import { RUN_EVENT_CUSTOM_TYPE, rebuildRunState } from "./persistence.js";
import {
  countStatuses,
  createRunRuntimeState,
  getOrderedRuns,
  getRunNodes,
  iconForStatus,
  markRunningRunsAborted,
} from "./state.js";
import type {
  AgentRunDetails,
  RunResultDetails,
  SpawnNodeResult,
  WorkflowParams,
} from "./types.js";

type ToolPromptMetadata = {
  promptSnippet?: string;
  promptGuidelines?: string[];
};

class UnknownAgentError extends Error {
  readonly details: AgentRunDetails;

  constructor(message: string, details: AgentRunDetails) {
    super(message);
    this.name = "UnknownAgentError";
    this.details = details;
  }
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

const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const OutputModeSchema = StringEnum(["text", "json"] as const);
const JoinModeSchema = StringEnum(["all", "any", "quorum"] as const);
const JoinFailureSchema = StringEnum(["failFast", "collectErrors"] as const);

const ContinueSpecSchema = Type.Object({
  kind: Type.Literal("result_field"),
  path: Type.String({
    description: "Field path to inspect on the body result",
  }),
  equals: Type.Boolean({
    description: "Loop while the field equals this value",
  }),
});

const JoinReducerSchema = Type.Union([
  Type.Object({ kind: Type.Literal("collect") }),
  Type.Object({
    kind: Type.Literal("agent"),
    agent: Type.String({ description: "Agent used to reduce branch results" }),
    task: Type.String({ description: "Reducer task prompt" }),
    output: Type.Optional(OutputModeSchema),
  }),
]);

const FlowSpecSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      kind: Type.Literal("spawn"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      agent: Type.String({ description: "Agent name to execute" }),
      task: Type.String({ description: "Task prompt passed to the agent" }),
      cwd: Type.Optional(Type.String()),
      scope: Type.Optional(ScopeSchema),
      output: Type.Optional(OutputModeSchema),
    }),
    Type.Object({
      kind: Type.Literal("sequence"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      steps: Type.Array(Self, {
        description:
          "Nodes executed in order; the last output becomes the sequence output",
      }),
    }),
    Type.Object({
      kind: Type.Literal("fork"),
      id: Type.String({
        description: "Unique fork identifier for downstream joins",
      }),
      label: Type.Optional(Type.String()),
      branches: Type.Record(Type.String(), Self, {
        description: "Named branches executed concurrently",
      }),
      concurrency: Type.Optional(PositiveIntegerSchema),
    }),
    Type.Object({
      kind: Type.Literal("join"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      from: Type.String({ description: "Fork id to join" }),
      mode: JoinModeSchema,
      quorum: Type.Optional(PositiveIntegerSchema),
      reducer: Type.Optional(JoinReducerSchema),
      onFailure: Type.Optional(JoinFailureSchema),
    }),
    Type.Object({
      kind: Type.Literal("loop"),
      id: Type.String({ description: "Unique loop identifier" }),
      label: Type.Optional(Type.String()),
      body: Self,
      maxIterations: PositiveIntegerSchema,
      continueWhen: Type.Optional(ContinueSpecSchema),
    }),
  ]),
);

const WorkflowParamsSchema = Type.Object({
  label: Type.Optional(
    Type.String({ description: "Optional label shown in workflow UI" }),
  ),
  flow: FlowSpecSchema,
  budgets: Type.Optional(
    Type.Object({
      maxDepth: Type.Optional(PositiveIntegerSchema),
      maxChildren: Type.Optional(PositiveIntegerSchema),
      maxParallelism: Type.Optional(PositiveIntegerSchema),
      maxIterations: Type.Optional(PositiveIntegerSchema),
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
  lines.push("", "Use /agent <name> for full details.");
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
  runtimeState: ReturnType<typeof createRunRuntimeState>,
): string {
  const runs = getOrderedRuns(runtimeState);
  if (runs.length === 0) {
    return "No runs recorded in this session.";
  }

  const lines = ["Runs:"];
  for (const run of runs.slice(0, 10)) {
    const nodes = getRunNodes(runtimeState, run.id);
    lines.push(
      `- ${iconForStatus(run.status)} ${run.label} (${run.id.slice(0, 8)}) · ${run.status} · ${nodes.length} nodes`,
    );
  }
  return lines.join("\n");
}

function resolveRunId(
  runtimeState: ReturnType<typeof createRunRuntimeState>,
  query: string,
): { runId: string } | { error: string } {
  const trimmed = query.trim();
  if (!trimmed) {
    return { error: "Run ID must not be empty." };
  }

  if (runtimeState.runs.has(trimmed)) {
    return { runId: trimmed };
  }

  const matches = getOrderedRuns(runtimeState).filter((item) =>
    item.id.startsWith(trimmed),
  );
  const [match] = matches;
  if (matches.length === 1 && match) {
    return { runId: match.id };
  }

  if (matches.length > 1) {
    return {
      error: `Ambiguous run ID prefix "${trimmed}". Matches: ${matches
        .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
        .join(", ")}`,
    };
  }

  const known = getOrderedRuns(runtimeState)
    .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
    .join(", ");
  return { error: `Unknown run "${trimmed}". Known: ${known || "none"}` };
}

function formatRunDetailsText(
  runtimeState: ReturnType<typeof createRunRuntimeState>,
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

  const nodes = getRunNodes(runtimeState, run.id);
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

function extractTextContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (
        item,
      ): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function formatUsageSummary(details: AgentRunDetails): string {
  const usage = details.usage;
  return [
    `input=${usage.input}`,
    `output=${usage.output}`,
    `context=${usage.contextTokens}`,
    `turns=${usage.turns}`,
    `cost=${usage.cost}`,
  ].join(" · ");
}

function previewText(text: string, expanded: boolean, maxLines = 8): string {
  const lines = text.split("\n");
  if (expanded || lines.length <= maxLines) {
    return text;
  }
  const remaining = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n... (${remaining} more lines)`;
}

function describeFlow(flow: WorkflowParams["flow"]): string {
  switch (flow.kind) {
    case "spawn":
      return `spawn ${flow.agent}`;
    case "sequence":
      return `sequence (${flow.steps.length} steps)`;
    case "fork":
      return `fork (${Object.keys(flow.branches).length} branches${flow.concurrency ? `, concurrency=${flow.concurrency}` : ""})`;
    case "join":
      return `join from ${flow.from} (${flow.mode})`;
    case "loop":
      return `loop (${flow.maxIterations} iterations max)`;
  }
}

function createRenderer(lines: string[]) {
  return {
    render() {
      return lines;
    },
    invalidate() {},
  };
}

function getCurrentModelId(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function pushSection(
  lines: string[],
  title: string,
  body: string | undefined,
  theme: Theme,
): void {
  if (!body) {
    return;
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(theme.fg("toolTitle", theme.bold(title)));
  lines.push(theme.fg("toolOutput", body));
}

function renderAgentCall(
  args: { name: string; task: string; scope?: Scope; cwd?: string },
  theme: Theme,
) {
  const lines = [theme.fg("toolTitle", theme.bold(`agent ${args.name}`))];
  const metadata = [
    `scope=${args.scope ?? "both"}`,
    args.cwd ? `cwd=${args.cwd}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (metadata) {
    lines.push(theme.fg("muted", metadata));
  }
  pushSection(lines, "Task", previewText(args.task, false, 6), theme);
  return createRenderer(lines);
}

function renderAgentResult(
  result: AgentToolResult<AgentRunDetails>,
  expanded: boolean,
  theme: Theme,
) {
  const details = result.details;
  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(
        `${details.agent} · ${details.agentSource} · exit ${details.exitCode}`,
      ),
    ),
    theme.fg("muted", formatUsageSummary(details)),
  ];

  if (details.missingSkills.length > 0) {
    pushSection(
      lines,
      "Missing skills",
      details.missingSkills.join(", "),
      theme,
    );
  }
  if (details.discoveryDiagnostics.length > 0) {
    pushSection(
      lines,
      "Discovery diagnostics",
      details.discoveryDiagnostics.join("\n"),
      theme,
    );
  }

  const output = extractTextContent(result);
  if (output) {
    pushSection(lines, "Output", previewText(output, expanded, 10), theme);
  }
  return createRenderer(lines);
}

function renderWorkflowCall(args: WorkflowParams, theme: Theme) {
  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(args.label ? `workflow ${args.label}` : "workflow"),
    ),
    theme.fg(
      "muted",
      [
        describeFlow(args.flow),
        `scope=${args.scope ?? "both"}`,
        args.cwd ? `cwd=${args.cwd}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ];
  if (args.budgets) {
    pushSection(lines, "Budgets", formatOutput(args.budgets), theme);
  }
  return createRenderer(lines);
}

function renderWorkflowResult(
  result: AgentToolResult<RunResultDetails>,
  expanded: boolean,
  theme: Theme,
) {
  const details = result.details;
  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(`${details.run.label} · ${details.run.status}`),
    ),
    theme.fg(
      "muted",
      `run=${details.run.id.slice(0, 8)} · nodes=${details.nodes.length} · scope=${details.run.scope}`,
    ),
  ];
  const output = details.result
    ? formatOutput(details.result.output)
    : extractTextContent(result);
  if (output) {
    pushSection(lines, "Result", previewText(output, expanded, 12), theme);
  }
  if (details.run.error) {
    pushSection(lines, "Error", details.run.error, theme);
  }
  return createRenderer(lines);
}

function getRootSpawnResult(
  details: RunResultDetails,
): SpawnNodeResult | undefined {
  return details.result?.kind === "spawn" ? details.result : undefined;
}

function rebuildRuntimeState(
  runtimeState: ReturnType<typeof createRunRuntimeState>,
  ctx: ExtensionContext,
): void {
  const rebuilt = rebuildRunState(ctx.sessionManager.getBranch());
  runtimeState.runs.clear();
  runtimeState.nodes.clear();
  runtimeState.order.length = 0;
  for (const [id, run] of rebuilt.runs.entries()) {
    runtimeState.runs.set(id, run);
  }
  for (const [id, node] of rebuilt.nodes.entries()) {
    runtimeState.nodes.set(id, node);
  }
  runtimeState.order.push(...rebuilt.order);
  markRunningRunsAborted(runtimeState);
}

function updateRunUI(
  ctx: ExtensionContext | undefined,
  runtimeState: ReturnType<typeof createRunRuntimeState>,
): void {
  if (!ctx?.hasUI) return;
  const runs = getOrderedRuns(runtimeState);
  const active = runs.filter((run) => run.status === "running");

  if (active.length === 0) {
    ctx.ui.setWidget("pi-agents-runs", undefined);
    ctx.ui.setStatus("pi-agents-runs", undefined);
    return;
  }

  const lines = ["● runs"];
  for (const run of active.slice(0, 5)) {
    const nodes = getRunNodes(runtimeState, run.id);
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
    `${counts.runs} runs · ${counts.running} agents running · ${counts.waiting} waiting nodes`,
  );
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
