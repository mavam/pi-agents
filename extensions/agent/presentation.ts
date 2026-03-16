import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Agent, Scope } from "./agents.js";
import { type MermaidOptions, toMermaid } from "./mermaid.js";
import { rebuildRunState } from "./persistence.js";
import {
  countStatuses,
  getOrderedRuns,
  getRunNodes,
  iconForKind,
  iconForStatus,
  markRunningRunsAborted,
  type RunRuntimeState,
} from "./state.js";
import type {
  AgentRunDetails,
  FlowSpec,
  ForkFlowSpec,
  JoinFlowSpec,
  LoopFlowSpec,
  RunNode,
  RunResultDetails,
  SpawnFlowSpec,
  SpawnNodeResult,
  WorkflowParams,
} from "./types.js";

// ---------------------------------------------------------------------------
// Agent listing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Run overview / details
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Flow tree — ASCII visualization of a FlowSpec
// ---------------------------------------------------------------------------

/** Map from specId → RunNode for fast status lookups. */
type NodeIndex = ReadonlyMap<string, RunNode>;

function buildNodeIndex(
  runtimeState: RunRuntimeState | undefined,
  runId: string | undefined,
): NodeIndex {
  if (!runtimeState || !runId) return new Map();
  const nodes = getRunNodes(runtimeState, runId);
  const index = new Map<string, RunNode>();
  for (const node of nodes) {
    if (node.specId) {
      index.set(node.specId, node);
    }
  }
  return index;
}

function flowIcon(spec: FlowSpec, nodeIndex: NodeIndex): string {
  if (spec.id) {
    const node = nodeIndex.get(spec.id);
    if (node) return iconForStatus(node.status);
  }
  return iconForKind(spec.kind);
}

function spawnLabel(spec: SpawnFlowSpec): string {
  return spec.label ?? spec.agent;
}

function forkLabel(spec: ForkFlowSpec): string {
  return spec.label ?? spec.id;
}

function joinLabel(spec: JoinFlowSpec): string {
  const modeStr = spec.mode === "quorum" ? `quorum(${spec.quorum})` : spec.mode;
  const base = spec.label ?? `join: ${modeStr}`;
  return `${base} ← ${spec.from}`;
}

function loopLabel(spec: LoopFlowSpec, nodeIndex: NodeIndex): string {
  const base = spec.label ?? spec.id;
  if (spec.id) {
    const node = nodeIndex.get(spec.id);
    if (node?.iteration !== undefined) {
      return `${base} (${node.iteration}/${spec.maxIterations} iterations)`;
    }
  }
  return `${base} (max ${spec.maxIterations})`;
}

interface TreeContext {
  lines: string[];
  nodeIndex: NodeIndex;
}

/**
 * Emit lines for a list of sibling specs at the given indent prefix.
 * `prefix` is the string prepended to every line (e.g. `"│  "`).
 */
function emitChildren(
  specs: FlowSpec[],
  prefix: string,
  ctx: TreeContext,
): void {
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!spec) continue;
    const isLast = i === specs.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = isLast ? `${prefix}   ` : `${prefix}│  `;
    emitSpec(spec, prefix, connector, childPrefix, ctx);
  }
}

function emitSpec(
  spec: FlowSpec,
  prefix: string,
  connector: string,
  childPrefix: string,
  ctx: TreeContext,
): void {
  switch (spec.kind) {
    case "spawn": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${prefix}${connector} ${icon} ${spawnLabel(spec)}`);
      return;
    }
    case "sequence": {
      // Sequence is transparent: inline its children at the current level.
      // We emit each step as a sibling at the *parent's* indentation so
      // sequences don't add visual nesting.
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];
        if (!step) continue;
        // For intermediate steps, use the same prefix/connector logic as
        // the parent would for siblings. The sequence "takes over" the
        // connector slot of its first child and the last-child slot of
        // its last child.
        const isFirstStep = i === 0;
        const isLastStep = i === spec.steps.length - 1;

        // The first step inherits the connector that was given to the
        // sequence itself. Subsequent steps use the childPrefix that
        // the parent prepared for continuation lines.
        const stepConnector = isFirstStep
          ? connector
          : isLastStep
            ? "└─"
            : "├─";
        const stepPrefix = isFirstStep ? prefix : childPrefix;
        const stepChildPrefix = isLastStep
          ? `${childPrefix}   `
          : `${childPrefix}│  `;

        emitSpec(step, stepPrefix, stepConnector, stepChildPrefix, ctx);
      }
      return;
    }
    case "fork": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${prefix}${connector} ${icon} ${forkLabel(spec)}`);

      const keys = Object.keys(spec.branches).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] ?? "";
        const branchSpec = spec.branches[key];
        if (!branchSpec) continue;
        const isLastBranch = i === keys.length - 1;
        const branchConnector = isLastBranch ? "└─" : "├─";
        const branchChildPrefix = isLastBranch
          ? `${childPrefix}   `
          : `${childPrefix}│  `;

        // If the branch body is a single spawn, render it inline:
        //   ├─ fast → ● fast-worker
        if (branchSpec.kind === "spawn") {
          const spawnIcon = flowIcon(branchSpec, ctx.nodeIndex);
          ctx.lines.push(
            `${childPrefix}${branchConnector} ${key} → ${spawnIcon} ${spawnLabel(branchSpec)}`,
          );
        } else {
          // Multi-node branch: label line, then children indented.
          ctx.lines.push(`${childPrefix}${branchConnector} ${key}`);
          if (branchSpec.kind === "sequence") {
            emitChildren(branchSpec.steps, branchChildPrefix, ctx);
          } else {
            emitSpec(
              branchSpec,
              branchChildPrefix,
              "└─",
              `${branchChildPrefix}   `,
              ctx,
            );
          }
        }
      }
      return;
    }
    case "join": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${prefix}${connector} ${icon} ${joinLabel(spec)}`);
      return;
    }
    case "loop": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(
        `${prefix}${connector} ${icon} ${loopLabel(spec, ctx.nodeIndex)}`,
      );

      // Loop body
      if (spec.body.kind === "sequence") {
        emitChildren(spec.body.steps, childPrefix, ctx);
      } else {
        emitSpec(spec.body, childPrefix, "└─", `${childPrefix}   `, ctx);
      }
      return;
    }
  }
}

/**
 * Format a FlowSpec as an ASCII tree.
 *
 * When `runtimeState` and `runId` are given, status icons from the run
 * replace the static kind icons.
 *
 * Sequences are transparent — their children are inlined at the parent
 * indentation level, so the top-level sequence never adds visual noise.
 */
export function formatFlowTree(
  flow: FlowSpec,
  runtimeState?: RunRuntimeState,
  runId?: string,
): string[] {
  const ctx: TreeContext = {
    lines: [],
    nodeIndex: buildNodeIndex(runtimeState, runId),
  };

  if (flow.kind === "sequence") {
    // Top-level sequence: emit children at root (no prefix).
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      if (!step) continue;
      const isLast = i === flow.steps.length - 1;
      emitRootChild(step, isLast, ctx);
    }
  } else {
    emitRootChild(flow, true, ctx);
  }

  return ctx.lines;
}

/**
 * Emit a root-level child. Root children have no leading tree prefix —
 * they start at column 0 with just their icon and label.
 */
function emitRootChild(
  spec: FlowSpec,
  _isLast: boolean,
  ctx: TreeContext,
): void {
  switch (spec.kind) {
    case "spawn": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${icon} ${spawnLabel(spec)}`);
      return;
    }
    case "sequence": {
      for (const step of spec.steps) {
        emitRootChild(step, false, ctx);
      }
      return;
    }
    case "fork": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${icon} ${forkLabel(spec)}`);

      const keys = Object.keys(spec.branches).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] ?? "";
        const branchSpec = spec.branches[key];
        if (!branchSpec) continue;
        const isLastBranch = i === keys.length - 1;
        const branchConnector = isLastBranch ? "└─" : "├─";
        const branchChildPrefix = isLastBranch ? "   " : "│  ";

        if (branchSpec.kind === "spawn") {
          const spawnIcon = flowIcon(branchSpec, ctx.nodeIndex);
          ctx.lines.push(
            `${branchConnector} ${key} → ${spawnIcon} ${spawnLabel(branchSpec)}`,
          );
        } else {
          ctx.lines.push(`${branchConnector} ${key}`);
          if (branchSpec.kind === "sequence") {
            emitChildren(branchSpec.steps, branchChildPrefix, ctx);
          } else {
            emitSpec(
              branchSpec,
              branchChildPrefix,
              "└─",
              `${branchChildPrefix}   `,
              ctx,
            );
          }
        }
      }
      return;
    }
    case "join": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${icon} ${joinLabel(spec)}`);
      return;
    }
    case "loop": {
      const icon = flowIcon(spec, ctx.nodeIndex);
      ctx.lines.push(`${icon} ${loopLabel(spec, ctx.nodeIndex)}`);

      if (spec.body.kind === "sequence") {
        emitChildren(spec.body.steps, "", ctx);
      } else {
        emitSpec(spec.body, "", "└─", "   ", ctx);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// /flow command handler
// ---------------------------------------------------------------------------

export function formatFlowCommandOutput(
  runtimeState: RunRuntimeState,
  args: string,
): string {
  const parts = args.trim().split(/\s+/);
  const wantMermaid =
    parts.length > 0 && parts[parts.length - 1]?.toLowerCase() === "mermaid";
  const query = wantMermaid ? parts.slice(0, -1).join(" ") : args.trim();

  // Resolve run: use latest if no query given.
  let runId: string | undefined;
  if (query) {
    const resolved = resolveRunId(runtimeState, query);
    if ("error" in resolved) return resolved.error;
    runId = resolved.runId;
  } else {
    const latest = getOrderedRuns(runtimeState)[0];
    if (!latest) return "No runs recorded in this session.";
    runId = latest.id;
  }

  const run = runtimeState.runs.get(runId);
  if (!run) return `Unknown run "${runId}".`;

  if (wantMermaid) {
    const mermaidOptions: MermaidOptions = {};
    if (run.label) mermaidOptions.title = run.label;
    return ["```mermaid", toMermaid(run.flow, mermaidOptions), "```"].join(
      "\n",
    );
  }

  const header = `Flow: ${run.label} (${run.id.slice(0, 8)}) · ${run.status}`;
  const tree = formatFlowTree(run.flow, runtimeState, runId);
  return [header, ...tree].join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Line wrapping / renderer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool call / result renderers
// ---------------------------------------------------------------------------

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
        `scope=${args.scope ?? "both"}`,
        args.cwd ? `cwd=${args.cwd}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ];

  // Flow tree preview (static — no runtime state yet).
  const tree = formatFlowTree(args.flow);
  if (tree.length > 0) {
    lines.push("");
    for (const treeLine of tree) {
      lines.push(theme.fg("toolOutput", treeLine));
    }
  }

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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Live widget — timer-driven animated flow tree
// ---------------------------------------------------------------------------

/** Braille spinner frames (same sequence as pi's built-in Loader). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Maximum widget body lines before truncation. */
const MAX_WIDGET_LINES = 10;

/**
 * Build themed widget lines for active runs.
 *
 * For single-spawn runs the flow tree is redundant (it just repeats the run
 * label), so we only show the header. For multi-node workflows we show the
 * full tree with status overlay.
 */
export function buildWidgetLines(
  runtimeState: RunRuntimeState,
  spinner: string,
  theme: Theme,
  terminalWidth: number,
): string[] {
  const active = getOrderedRuns(runtimeState)
    .filter((run) => run.status === "running")
    .slice(0, 5);

  if (active.length === 0) return [];

  const truncate = (line: string) => truncateToWidth(line, terminalWidth);

  const lines: string[] = [
    `${theme.fg("accent", "●")} ${theme.fg("accent", "Runs")}`,
  ];
  for (const [i, run] of active.entries()) {
    const isLast = i === active.length - 1;
    const connector = isLast ? "└─" : "├─";
    const indent = isLast ? "   " : "│  ";

    // Header line with animated spinner.
    lines.push(
      truncate(
        `${theme.fg("dim", connector)} ${theme.fg("accent", spinner)} ${theme.bold(run.label)} ${theme.fg("dim", run.id.slice(0, 8))}`,
      ),
    );

    // Flow tree — skip for trivial single-spawn runs.
    const isTrivial =
      run.flow.kind === "spawn" ||
      (run.flow.kind === "sequence" &&
        run.flow.steps.length === 1 &&
        run.flow.steps[0]?.kind === "spawn");

    if (!isTrivial) {
      const tree = formatFlowTree(run.flow, runtimeState, run.id);
      for (const treeLine of tree) {
        // Replace the static running icon with the animated spinner frame.
        const themed = treeLine.replaceAll("⠹", spinner);
        lines.push(
          truncate(`${theme.fg("dim", indent)}${theme.fg("muted", themed)}`),
        );
      }
    }
  }

  // Cap overflow.
  if (lines.length > MAX_WIDGET_LINES) {
    const hidden = lines.length - MAX_WIDGET_LINES + 1;
    lines.length = MAX_WIDGET_LINES - 1;
    lines.push(theme.fg("dim", `└─ +${hidden} more…`));
  }

  return lines;
}

/**
 * Manages the live widget timer for active runs.
 *
 * Follows the pi-subagents pattern: a single `setInterval` at 80 ms cycles
 * through braille spinner frames and rebuilds the string lines. The widget
 * uses the `{ render, invalidate }` factory form of `setWidget` — no TUI
 * component tree needed.
 */
export class RunWidgetManager {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastCtx: ExtensionContext | undefined;

  constructor(private runtimeState: RunRuntimeState) {}

  update(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    if (!ctx.hasUI) return;

    const active = getOrderedRuns(this.runtimeState).filter(
      (run) => run.status === "running",
    );

    if (active.length === 0) {
      this.stop(ctx);
      return;
    }

    // Ensure timer is running.
    if (!this.interval) {
      this.interval = setInterval(() => this.tick(), 80);
    }

    this.render(ctx);
  }

  private tick(): void {
    this.frame += 1;
    if (this.lastCtx?.hasUI) {
      this.render(this.lastCtx);
    }
  }

  private render(ctx: ExtensionContext): void {
    const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "⠹";

    ctx.ui.setWidget("pi-agents-runs", (_tui, theme) => {
      const w = _tui.terminal?.columns ?? 120;
      const lines = buildWidgetLines(this.runtimeState, spinner, theme, w);
      return { render: () => lines, invalidate: () => {} };
    });

    const counts = countStatuses(this.runtimeState);
    ctx.ui.setStatus(
      "pi-agents-runs",
      `${counts.runs} runs · ${counts.running} running · ${counts.waiting} waiting`,
    );
  }

  private stop(ctx: ExtensionContext): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    ctx.ui.setWidget("pi-agents-runs", undefined);
    ctx.ui.setStatus("pi-agents-runs", undefined);
  }
}
