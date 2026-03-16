import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Agent, Scope } from "./agents.js";
import { rebuildRunState } from "./persistence.js";
import {
  countStatuses,
  getOrderedRuns,
  getRunNodes,
  iconForStatus,
  markRunningRunsAborted,
  type RunRuntimeState,
} from "./state.js";
import type {
  AgentRunDetails,
  RunResultDetails,
  SpawnNodeResult,
  WorkflowParams,
} from "./types.js";

export function formatAgentsOverview(
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

export function formatAgentDetails(
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

export function formatRunOverviewText(runtimeState: RunRuntimeState): string {
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
  runtimeState: RunRuntimeState,
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

export function formatRunDetailsText(
  runtimeState: RunRuntimeState,
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

export function formatOutput(value: unknown): string {
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

function wrapLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  return lines.flatMap((line) => {
    const segments = line.split("\n");
    return segments.flatMap((segment) => {
      if (segment.length === 0) {
        return [""];
      }
      const wrapped = wrapTextWithAnsi(segment, safeWidth);
      return wrapped.length > 0 ? wrapped : [""];
    });
  });
}

function createRenderer(lines: string[]) {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  return {
    render(width: number) {
      if (cachedLines && cachedWidth === width) {
        return cachedLines;
      }

      cachedLines = wrapLines(lines, width);
      cachedWidth = width;
      return cachedLines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
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

export function renderAgentCall(
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

export function renderAgentResult(
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

export function renderWorkflowCall(args: WorkflowParams, theme: Theme) {
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

export function renderWorkflowResult(
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

export function getRootSpawnResult(
  details: RunResultDetails,
): SpawnNodeResult | undefined {
  return details.result?.kind === "spawn" ? details.result : undefined;
}

export function rebuildRuntimeState(
  runtimeState: RunRuntimeState,
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

export function renderActiveRunWidgetLines(
  runtimeState: RunRuntimeState,
): string[] {
  const active = getOrderedRuns(runtimeState)
    .filter((run) => run.status === "running")
    .slice(0, 5);

  if (active.length === 0) {
    return [];
  }

  const lines = ["● runs"];
  for (const [runIndex, run] of active.entries()) {
    const nodes = getRunNodes(runtimeState, run.id);
    const lastNodes = nodes.slice(-4);
    const visibleNodes =
      lastNodes.length === 1 &&
      lastNodes[0]?.kind === "spawn" &&
      (lastNodes[0].label ?? lastNodes[0].specId ?? lastNodes[0].kind) ===
        run.label
        ? []
        : lastNodes;
    const runPrefix = runIndex === active.length - 1 ? "└─" : "├─";
    const nodeStem = runIndex === active.length - 1 ? "   " : "│  ";

    lines.push(
      `${runPrefix} ${iconForStatus(run.status, "●")} ${run.label} ${run.id.slice(0, 8)} ${run.status}`,
    );

    for (const [nodeIndex, node] of visibleNodes.entries()) {
      const label = node.label ?? node.specId ?? node.kind;
      const nodePrefix = `${nodeStem}${nodeIndex === visibleNodes.length - 1 ? "└─" : "├─"}`;
      lines.push(`${nodePrefix} ${iconForStatus(node.status, "·")} ${label}`);
    }
  }

  return lines;
}

export function updateRunUI(
  ctx: ExtensionContext | undefined,
  runtimeState: RunRuntimeState,
): void {
  if (!ctx?.hasUI) return;
  const active = getOrderedRuns(runtimeState).filter(
    (run) => run.status === "running",
  );

  if (active.length === 0) {
    ctx.ui.setWidget("pi-agents-runs", undefined);
    ctx.ui.setStatus("pi-agents-runs", undefined);
    return;
  }

  const counts = countStatuses(runtimeState);
  ctx.ui.setWidget("pi-agents-runs", renderActiveRunWidgetLines(runtimeState));
  ctx.ui.setStatus(
    "pi-agents-runs",
    `${counts.runs} runs · ${counts.running} agents running · ${counts.waiting} waiting nodes`,
  );
}
