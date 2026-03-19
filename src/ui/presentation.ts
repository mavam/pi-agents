import type {
  AgentToolResult,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { editorKey } from "@mariozechner/pi-coding-agent";
import {
  Box,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { Agent, Scope } from "../catalog/agents.js";
import type { LiveRunRegistry } from "../runtime/live-runs.js";
import { rebuildRunState } from "../runtime/persistence.js";
import type { RunEventCache } from "../runtime/session-events.js";
import {
  getOrderedRuns,
  getRunNodes,
  getRunSnapshot,
  iconForKind,
  iconForStatus,
  markRunningRunsStopped,
  type RunRuntimeState,
} from "../runtime/state.js";
import type {
  AgentRunDetails,
  FlowNodeResult,
  FlowSpec,
  ForkFlowSpec,
  JoinFlowSpec,
  LoopFlowSpec,
  RunNode,
  RunNotificationDetails,
  RunResultDetails,
  SpawnFlowSpec,
  SpawnNodeResult,
  WorkflowParams,
  WorkflowRun,
} from "../runtime/types.js";
import {
  forkBranchPath,
  loopBodyPath,
  ROOT_FLOW_PATH,
  sequenceStepPath,
} from "../workflow/flow-path.js";
import { normalizeWorkflowParams } from "../workflow/flow-spec.js";
import {
  type MermaidOptions,
  renderFlowAscii,
  toMermaid,
} from "../workflow/mermaid.js";

export const RUN_NOTIFICATION_CUSTOM_TYPE = "pi-agents:notification";

interface RenderableCustomMessage<T> {
  content: string | unknown[];
  details?: T;
}

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
// Flow overview / details
// ---------------------------------------------------------------------------

export function formatFlowOverviewText(runtimeState: RunRuntimeState): string {
  const runs = getOrderedRuns(runtimeState);
  if (runs.length === 0) {
    return "No flows recorded in this session.";
  }

  const lines = ["Flows:"];
  for (const run of runs.slice(0, 10)) {
    const nodes = getRunNodes(runtimeState, run.id);
    lines.push(
      `- ${run.label} (${run.id.slice(0, 8)}) · ${formatRunStatus(run)} · ${nodes.length} nodes ${iconForStatus(run.status)}`,
    );
  }
  return lines.join("\n");
}

export function resolveFlowId(
  runtimeState: RunRuntimeState,
  query: string,
): { runId: string } | { error: string } {
  const trimmed = query.trim();
  if (!trimmed) {
    return { error: "Flow ID must not be empty." };
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
      error: `Ambiguous flow ID prefix "${trimmed}". Matches: ${matches
        .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
        .join(", ")}`,
    };
  }

  const known = getOrderedRuns(runtimeState)
    .map((item) => `${item.id.slice(0, 8)} → ${item.id}`)
    .join(", ");
  return { error: `Unknown flow "${trimmed}". Known: ${known || "none"}` };
}

function summarizeFlowResult(
  result: FlowNodeResult | undefined,
): string | undefined {
  if (!result) return undefined;
  return (
    summarizeStructuredWorkflowOutput(result.output) ??
    firstMeaningfulLine(result.output)
  );
}

function summarizeNodeRuntimeOutput(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return firstMeaningfulLine(output);
  }

  const record = output as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;

  if (kind === "fork") {
    const branches =
      typeof record.branches === "object" && record.branches !== null
        ? (record.branches as Record<string, unknown>)
        : undefined;
    if (branches) {
      const successes = Object.fromEntries(
        Object.entries(branches)
          .filter(
            ([, value]) =>
              !(typeof value === "object" && value && "error" in value),
          )
          .map(([key, value]) => [key, value]),
      );
      const errors = Object.fromEntries(
        Object.entries(branches)
          .filter(
            ([, value]) =>
              typeof value === "object" && value !== null && "error" in value,
          )
          .map(([key, value]) => [
            key,
            String((value as Record<string, unknown>).error),
          ]),
      );
      return summarizeStructuredWorkflowOutput({ branches: successes, errors });
    }
  }

  if (kind === "join") {
    const selected = Array.isArray(record.selectedBranches)
      ? record.selectedBranches.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const summary =
      typeof record.output === "string"
        ? firstMeaningfulLine(record.output)
        : undefined;
    return selected.length > 0
      ? summary && !summary.startsWith("{")
        ? `${selected.length} selected branch(es) · ${summary}`
        : `${selected.length} selected branch(es): ${selected.join(", ")}`
      : summary;
  }

  if (kind === "loop") {
    const iterations =
      typeof record.iterations === "number" ? record.iterations : undefined;
    const summary =
      typeof record.output === "string"
        ? firstMeaningfulLine(record.output)
        : undefined;
    if (iterations !== undefined) {
      return summary && !summary.startsWith("{")
        ? `${iterations} iteration(s) · ${summary}`
        : `${iterations} iteration(s)`;
    }
    return summary;
  }

  if (typeof record.output === "string") {
    return firstMeaningfulLine(record.output);
  }

  return firstMeaningfulLine(output);
}

function formatInspectNodeLine(
  runFlow: FlowSpec,
  node: RunNode,
): string | undefined {
  const suffix: string[] = [];
  if (node.branchKey) suffix.push(`branch=${node.branchKey}`);
  if (node.iteration !== undefined) suffix.push(`iteration=${node.iteration}`);
  const label = latestNodeDisplayLabel(runFlow, node);
  const summary = node.error
    ? firstMeaningfulLine(node.error)
    : summarizeNodeRuntimeOutput(node.output);
  if (!summary) return undefined;
  return `- ${iconForStatus(node.status)} ${label}${suffix.length > 0 ? ` (${suffix.join(", ")})` : ""}: ${summary}`;
}

export function formatNodeResultLines(
  run: WorkflowRun,
  nodes: RunNode[],
  options?: { limit?: number },
): string[] {
  const interesting = nodes.filter(
    (node) =>
      (node.id !== run.rootNodeId || nodes.length === 1) &&
      (node.status === "completed" || node.status === "stopped") &&
      (node.output !== undefined || node.error),
  );

  const selected =
    options?.limit && options.limit > 0
      ? interesting.slice(-options.limit)
      : interesting;

  return selected
    .map((node) => formatInspectNodeLine(run.flow, node))
    .filter((line): line is string => Boolean(line));
}

function formatInspectResults(run: WorkflowRun, nodes: RunNode[]): string[] {
  const lines = formatNodeResultLines(run, nodes);
  const resultSummary = summarizeFlowResult(run.result);
  const includeFlowResult =
    resultSummary !== undefined && !(lines.length > 0 && nodes.length === 1);
  if (includeFlowResult) {
    lines.push(`- Flow: ${resultSummary}`);
  }
  return lines.length > 0 ? ["", "Results:", ...lines] : [];
}

export function formatFlowInspectText(
  runtimeState: RunRuntimeState,
  runId: string,
): string {
  const resolved = resolveFlowId(runtimeState, runId);
  if ("error" in resolved) {
    return resolved.error;
  }

  const run = runtimeState.runs.get(resolved.runId);
  if (!run) {
    return `Unknown flow "${runId}".`;
  }

  const nodes = getRunNodes(runtimeState, run.id);
  const lines = [
    `Flow: ${run.label}`,
    `ID: ${run.id}`,
    `Status: ${formatRunStatus(run)}`,
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

  const tree = formatFlowTree(run.flow);
  if (tree.length > 0) {
    lines.push("", "Structure:", ...tree);
  }

  const statusTree = formatFlowTree(run.flow, runtimeState, run.id);
  if (statusTree.length > 0) {
    lines.push("", "Status:", ...statusTree);
  }

  lines.push(...formatInspectResults(run, nodes));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flow tree — ASCII visualization of a FlowSpec
// ---------------------------------------------------------------------------

/** Index RunNodes by canonical specPath. Multiple runtime nodes may share a
 * path, for example loop bodies across iterations. */
interface NodeIndex {
  bySpecPath: ReadonlyMap<string, RunNode[]>;
}

function buildNodeIndex(
  runtimeState: RunRuntimeState | undefined,
  runId: string | undefined,
): NodeIndex {
  const empty: NodeIndex = { bySpecPath: new Map() };
  if (!runtimeState || !runId) return empty;
  const bySpecPath = new Map<string, RunNode[]>();
  for (const node of getRunNodes(runtimeState, runId)) {
    if (!node.specPath) continue;
    const group = bySpecPath.get(node.specPath);
    if (group) group.push(node);
    else bySpecPath.set(node.specPath, [node]);
  }
  return { bySpecPath };
}

function latestNode(
  nodes: readonly RunNode[] | undefined,
): RunNode | undefined {
  return nodes?.[nodes.length - 1];
}

function aggregatedStatus(
  nodes: readonly RunNode[] | undefined,
): RunNode["status"] | undefined {
  if (!nodes || nodes.length === 0) return undefined;
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "waiting")) return "waiting";
  const latest = latestNode(nodes);
  return latest?.status;
}

function colorIcon(icon: string, theme: Theme): string {
  switch (icon) {
    case "●":
      return theme.fg("success", icon);
    case "◉":
      return theme.fg("accent", icon);
    case "○":
      return theme.fg("dim", icon);
    case "⊘":
      return theme.fg("warning", icon);
    default:
      return theme.fg("accent", icon);
  }
}

function flowIcon(spec: FlowSpec, specPath: string, ctx: TreeContext): string {
  const status = aggregatedStatus(ctx.nodeIndex.bySpecPath.get(specPath));
  const icon = status ? iconForStatus(status) : iconForKind(spec.kind);
  return ctx.theme ? colorIcon(icon, ctx.theme) : icon;
}

function spawnLabel(spec: SpawnFlowSpec): string {
  return spec.label ?? spec.agent;
}

function forkLabel(spec: ForkFlowSpec): string {
  return spec.label ?? spec.id;
}

function joinLabel(spec: JoinFlowSpec): string {
  if (spec.label) return spec.label;
  return spec.mode === "quorum" ? `quorum(${spec.quorum})` : spec.mode;
}

function flowLabel(spec: FlowSpec): string {
  switch (spec.kind) {
    case "spawn":
      return spawnLabel(spec);
    case "fork":
      return forkLabel(spec);
    case "join":
      return joinLabel(spec);
    case "loop":
      return spec.label ?? spec.id;
    case "sequence":
      return spec.label ?? "sequence";
  }
}

function resolveSpecAtPath(
  flow: FlowSpec,
  specPath: string | undefined,
): FlowSpec | undefined {
  if (!specPath) return undefined;
  if (specPath === ROOT_FLOW_PATH) return flow;
  if (!specPath.startsWith(`${ROOT_FLOW_PATH}.`)) return undefined;

  let current: FlowSpec | undefined = flow;
  const segments = specPath.slice(`${ROOT_FLOW_PATH}.`.length);
  const pattern = /steps\[(\d+)\]|branches\[(.+?)\]|body/g;

  for (const match of segments.matchAll(pattern)) {
    if (!current) return undefined;
    if (match[1] !== undefined) {
      if (current.kind !== "sequence") return undefined;
      current = current.steps[Number(match[1])];
      continue;
    }
    if (match[2] !== undefined) {
      if (current.kind !== "fork") return undefined;
      current = current.branches[JSON.parse(match[2]) as string];
      continue;
    }
    if (match[0] === "body") {
      if (current.kind !== "loop") return undefined;
      current = current.body;
    }
  }

  return current;
}

function latestNodeDisplayLabel(runFlow: FlowSpec, node: RunNode): string {
  if (node.label) return node.label;
  const spec = resolveSpecAtPath(runFlow, node.specPath);
  return spec ? flowLabel(spec) : node.id;
}

function loopLabel(
  spec: LoopFlowSpec,
  specPath: string,
  nodeIndex: NodeIndex,
): string {
  const base = spec.label ?? spec.id;
  const node = latestNode(nodeIndex.bySpecPath.get(specPath));
  if (node?.iteration !== undefined) {
    return `${base} (${node.iteration}/${spec.maxIterations} iterations)`;
  }
  return `${base} (max ${spec.maxIterations})`;
}

interface TreeContext {
  lines: string[];
  nodeIndex: NodeIndex;
  theme?: Theme;
}

/** Dim runs of tree-drawing characters (├─ └─ │) when a theme is available. */
function dimChrome(text: string, theme: Theme | undefined): string {
  if (!theme) return text;
  return text.replace(/[├└│─]+/g, (run) => theme.fg("dim", run));
}

/**
 * Emit lines for a list of sibling specs at the given indent prefix.
 * `prefix` is the string prepended to every line (for example `"│  "`).
 */
function emitChildren(
  specs: FlowSpec[],
  parentPath: string,
  prefix: string,
  ctx: TreeContext,
): void {
  for (const [index, spec] of specs.entries()) {
    if (!spec) continue;
    const isLast = index === specs.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = isLast ? `${prefix}   ` : `${prefix}│  `;
    emitSpec(
      spec,
      sequenceStepPath(parentPath, index),
      prefix,
      connector,
      childPrefix,
      ctx,
    );
  }
}

function emitSpec(
  spec: FlowSpec,
  specPath: string,
  prefix: string,
  connector: string,
  childPrefix: string,
  ctx: TreeContext,
): void {
  switch (spec.kind) {
    case "spawn": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${prefix}${connector} ${icon} ${spawnLabel(spec)}`);
      return;
    }
    case "sequence": {
      for (const [index, step] of spec.steps.entries()) {
        if (!step) continue;
        const isFirstStep = index === 0;
        const isLastStep = index === spec.steps.length - 1;
        const stepConnector = isFirstStep
          ? connector
          : isLastStep
            ? "└─"
            : "├─";
        const stepPrefix = isFirstStep ? prefix : childPrefix;
        const stepChildPrefix = isLastStep
          ? `${childPrefix}   `
          : `${childPrefix}│  `;

        emitSpec(
          step,
          sequenceStepPath(specPath, index),
          stepPrefix,
          stepConnector,
          stepChildPrefix,
          ctx,
        );
      }
      return;
    }
    case "fork": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${prefix}${connector} ${icon} ${forkLabel(spec)}`);

      const keys = Object.keys(spec.branches).sort();
      for (const [index, key] of keys.entries()) {
        const branchSpec = spec.branches[key];
        if (!branchSpec) continue;
        const isLastBranch = index === keys.length - 1;
        const branchConnector = isLastBranch ? "└─" : "├─";
        const branchChildPrefix = isLastBranch
          ? `${childPrefix}   `
          : `${childPrefix}│  `;
        const branchPath = forkBranchPath(specPath, key);

        if (branchSpec.kind === "spawn") {
          const spawnIcon = flowIcon(branchSpec, branchPath, ctx);
          ctx.lines.push(
            `${childPrefix}${branchConnector} ${spawnIcon} ${spawnLabel(branchSpec)}: ${key}`,
          );
        } else {
          ctx.lines.push(`${childPrefix}${branchConnector} ${key}`);
          if (branchSpec.kind === "sequence") {
            emitChildren(branchSpec.steps, branchPath, branchChildPrefix, ctx);
          } else {
            emitSpec(
              branchSpec,
              branchPath,
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
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${prefix}${connector} ${icon} ${joinLabel(spec)}`);
      return;
    }
    case "loop": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(
        `${prefix}${connector} ${icon} ${loopLabel(spec, specPath, ctx.nodeIndex)}`,
      );

      const bodyPath = loopBodyPath(specPath);
      if (spec.body.kind === "sequence") {
        emitChildren(spec.body.steps, bodyPath, childPrefix, ctx);
      } else {
        emitSpec(
          spec.body,
          bodyPath,
          childPrefix,
          "└─",
          `${childPrefix}   `,
          ctx,
        );
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
 */
export function formatFlowTree(
  flow: FlowSpec,
  runtimeState?: RunRuntimeState,
  runId?: string,
  theme?: Theme,
): string[] {
  const ctx: TreeContext = {
    lines: [],
    nodeIndex: buildNodeIndex(runtimeState, runId),
    theme,
  };

  if (flow.kind === "sequence") {
    if (flow.steps.length >= 2) {
      const seqLabel = flow.label ?? "sequence";
      const seqIcon = flowIcon(flow, ROOT_FLOW_PATH, ctx);
      ctx.lines.push(`${seqIcon} ${seqLabel}`);
      emitChildren(flow.steps, ROOT_FLOW_PATH, "", ctx);
    } else {
      for (const [index, step] of flow.steps.entries()) {
        if (!step) continue;
        emitRootChild(step, sequenceStepPath(ROOT_FLOW_PATH, index), ctx);
      }
    }
  } else {
    emitRootChild(flow, ROOT_FLOW_PATH, ctx);
  }

  return theme ? ctx.lines.map((line) => dimChrome(line, theme)) : ctx.lines;
}

/** Emit a root-level child with no tree prefix. */
function emitRootChild(
  spec: FlowSpec,
  specPath: string,
  ctx: TreeContext,
): void {
  switch (spec.kind) {
    case "spawn": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${icon} ${spawnLabel(spec)}`);
      return;
    }
    case "sequence": {
      for (const [index, step] of spec.steps.entries()) {
        if (!step) continue;
        emitRootChild(step, sequenceStepPath(specPath, index), ctx);
      }
      return;
    }
    case "fork": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${icon} ${forkLabel(spec)}`);

      const keys = Object.keys(spec.branches).sort();
      for (const [index, key] of keys.entries()) {
        const branchSpec = spec.branches[key];
        if (!branchSpec) continue;
        const isLastBranch = index === keys.length - 1;
        const branchConnector = isLastBranch ? "└─" : "├─";
        const branchChildPrefix = isLastBranch ? "   " : "│  ";
        const branchPath = forkBranchPath(specPath, key);

        if (branchSpec.kind === "spawn") {
          const spawnIcon = flowIcon(branchSpec, branchPath, ctx);
          ctx.lines.push(
            `${branchConnector} ${spawnIcon} ${spawnLabel(branchSpec)}: ${key}`,
          );
        } else {
          ctx.lines.push(`${branchConnector} ${key}`);
          if (branchSpec.kind === "sequence") {
            emitChildren(branchSpec.steps, branchPath, branchChildPrefix, ctx);
          } else {
            emitSpec(
              branchSpec,
              branchPath,
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
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${icon} ${joinLabel(spec)}`);
      return;
    }
    case "loop": {
      const icon = flowIcon(spec, specPath, ctx);
      ctx.lines.push(`${icon} ${loopLabel(spec, specPath, ctx.nodeIndex)}`);

      const bodyPath = loopBodyPath(specPath);
      if (spec.body.kind === "sequence") {
        emitChildren(spec.body.steps, bodyPath, "", ctx);
      } else {
        emitSpec(spec.body, bodyPath, "", "└─", "   ", ctx);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// /flow render helpers
// ---------------------------------------------------------------------------

export function formatFlowMermaidOutput(
  runtimeState: RunRuntimeState,
  runId: string,
): string {
  const resolved = resolveFlowId(runtimeState, runId);
  if ("error" in resolved) {
    return resolved.error;
  }

  const run = runtimeState.runs.get(resolved.runId);
  if (!run) return `Unknown flow "${runId}".`;

  const mermaidOptions: MermaidOptions = {};
  if (run.label) mermaidOptions.title = run.label;
  return ["```mermaid", toMermaid(run.flow, mermaidOptions), "```"].join("\n");
}

export function formatFlowDiagramOutput(
  runtimeState: RunRuntimeState,
  runId: string,
): string {
  const resolved = resolveFlowId(runtimeState, runId);
  if ("error" in resolved) {
    return resolved.error;
  }

  const run = runtimeState.runs.get(resolved.runId);
  if (!run) return `Unknown flow "${runId}".`;

  return renderFlowAscii(run.flow);
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

// ---------------------------------------------------------------------------
// XML envelope formatting — structured tool results for the LLM
// ---------------------------------------------------------------------------

function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescapeXmlText(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeXmlAttr(text: string): string {
  return escapeXmlText(text)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatXmlLeaf(tag: string, text: string, attrs?: string): string {
  const attrText = attrs ? ` ${attrs}` : "";
  return `<${tag}${attrText}>${escapeXmlText(text)}</${tag}>`;
}

function formatFlowResultInnerXml(result: FlowNodeResult): string {
  const output = formatOutput(result.output);
  const format = typeof result.output === "string" ? "text" : "json";
  return formatXmlLeaf("output", output, `format="${escapeXmlAttr(format)}"`);
}

/** Wrap a single-agent result in an XML envelope for the LLM. */
export function formatAgentResultXml(agent: string, text: string): string {
  return [
    `<agent_result agent="${escapeXmlAttr(agent)}">`,
    formatXmlLeaf("text", text),
    "</agent_result>",
  ].join("\n");
}

/** Wrap a workflow result in an XML envelope for the LLM. */
export function formatWorkflowResultXml(
  result: FlowNodeResult | undefined,
  runId: string,
): string {
  const attrs = [`run="${escapeXmlAttr(runId)}"`];
  if (result) {
    attrs.push(`kind="${escapeXmlAttr(result.kind)}"`);
  }

  return [
    `<workflow_result ${attrs.join(" ")}>`,
    result
      ? formatFlowResultInnerXml(result)
      : formatXmlLeaf("status", "completed"),
    "</workflow_result>",
  ].join("\n");
}

/**
 * Strip an `<agent_result>` or `<workflow_result>` XML envelope so TUI
 * renderers show clean text.
 */
export function stripResultXmlEnvelope(text: string): string {
  const patterns = [
    /^<agent_result\b[^>]*>\s*<text>([\s\S]*?)<\/text>\s*<\/agent_result>$/,
    /^<workflow_result\b[^>]*>\s*<output\b[^>]*>([\s\S]*?)<\/output>\s*<\/workflow_result>$/,
    /^<workflow_result\b[^>]*>\s*<status>([\s\S]*?)<\/status>\s*<\/workflow_result>$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] !== undefined) {
      return unescapeXmlText(match[1]);
    }
  }

  return text;
}

function firstMeaningfulLine(value: unknown): string {
  const text = typeof value === "string" ? value : formatOutput(value);
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "(empty)"
  );
}

function summarizeStructuredWorkflowOutput(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const branches =
    typeof record.branches === "object" && record.branches !== null
      ? (record.branches as Record<string, unknown>)
      : undefined;
  const errors =
    typeof record.errors === "object" && record.errors !== null
      ? (record.errors as Record<string, unknown>)
      : undefined;
  if (!branches && !errors) return undefined;

  const branchKeys = branches ? Object.keys(branches) : [];
  const errorKeys = errors ? Object.keys(errors) : [];

  if (branchKeys.length === 0 && errorKeys.length > 0) {
    const lines = [`${errorKeys.length} branch error(s)`];
    const uniqueMessages = [
      ...new Set(errorKeys.map((key) => firstMeaningfulLine(errors?.[key]))),
    ].filter(Boolean);
    if (uniqueMessages.length === 1) {
      const [message] = uniqueMessages;
      if (message) lines.push(message);
    }
    return lines.join("\n");
  }

  if (errorKeys.length === 0 && branchKeys.length > 0) {
    const lines = [`${branchKeys.length} branch result(s)`];
    for (const key of branchKeys.slice(0, 2)) {
      lines.push(`- ${key}: ${firstMeaningfulLine(branches?.[key])}`);
    }
    if (branchKeys.length > 2) {
      lines.push(`... (${branchKeys.length - 2} more branch result(s))`);
    }
    return lines.join("\n");
  }

  const lines = [
    `${branchKeys.length} branch result(s), ${errorKeys.length} error(s)`,
  ];
  for (const key of branchKeys.slice(0, 2)) {
    lines.push(`- ${key}: ${firstMeaningfulLine(branches?.[key])}`);
  }
  for (const key of errorKeys.slice(0, 2)) {
    lines.push(`- ${key} error: ${firstMeaningfulLine(errors?.[key])}`);
  }
  const hidden =
    Math.max(0, branchKeys.length - 2) + Math.max(0, errorKeys.length - 2);
  if (hidden > 0) lines.push(`... (${hidden} more item(s))`);
  return lines.join("\n");
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

function isPreviewTruncated(
  text: string,
  expanded: boolean,
  maxLines: number,
): boolean {
  return !expanded && text.split("\n").length > maxLines;
}

function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tokens`;
  return `${count} token${count === 1 ? "" : "s"}`;
}

function formatCompactDuration(
  startedAt: number | undefined,
  completedAt?: number,
): string | undefined {
  if (startedAt === undefined) return undefined;
  return `${(((completedAt ?? Date.now()) - startedAt) / 1000).toFixed(1)}s`;
}

function shortenModelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const tail = model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
  return tail
    .replace(/^claude[- ]/i, "")
    .replace(/^models\//i, "")
    .trim();
}

function truncateInline(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function extractPreviewLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = firstMeaningfulLine(stripResultXmlEnvelope(text));
  if (!line || line === "(empty)") return undefined;
  return truncateInline(line);
}

function currentSpinnerFrame(): string {
  return (
    SPINNER_FRAMES[
      Math.floor(Date.now() / FLOW_SUMMARY_TICK_MS) % SPINNER_FRAMES.length
    ] ?? "⠹"
  );
}

function getSpawnNodes(details: RunResultDetails): RunNode[] {
  return details.nodes.filter((node) => node.kind === "spawn");
}

function selectRepresentativeSpawnNode(
  details: RunResultDetails,
): RunNode | undefined {
  const spawnNodes = getSpawnNodes(details);
  const byRecency = (left: RunNode, right: RunNode) =>
    (right.progress?.updatedAt ?? right.completedAt ?? right.startedAt ?? 0) -
      (left.progress?.updatedAt ?? left.completedAt ?? left.startedAt ?? 0) ||
    right.id.localeCompare(left.id);

  const running = spawnNodes
    .filter((node) => node.status === "running")
    .sort(byRecency);
  if (running[0]) return running[0];

  return [...spawnNodes].sort(byRecency)[0];
}

function totalWorkflowTokens(details: RunResultDetails): number {
  return getSpawnNodes(details).reduce(
    (sum, node) => sum + (node.progress?.details?.usage.contextTokens ?? 0),
    0,
  );
}

function workflowPrimaryLabel(
  details: RunResultDetails,
  focus?: RunNode,
): string {
  if (focus) {
    const label = latestNodeDisplayLabel(details.run.flow, focus);
    if (label) return label;
  }
  return details.run.label;
}

function workflowPreviewLine(
  details: RunResultDetails,
  focus?: RunNode,
): string | undefined {
  return (
    focus?.progress?.preview ??
    extractPreviewLine(focus?.progress?.text) ??
    summarizeFlowResult(details.result) ??
    (focus?.error ? firstMeaningfulLine(focus.error) : undefined) ??
    (details.run.error ? firstMeaningfulLine(details.run.error) : undefined)
  );
}

function workflowBadgeParts(
  details: RunResultDetails,
  focus?: RunNode,
): string[] {
  const parts: string[] = [];
  const runningSpawnCount = getSpawnNodes(details).filter(
    (node) => node.status === "running",
  ).length;
  const model = shortenModelName(focus?.progress?.details?.model);
  if (model) parts.push(model);
  if (runningSpawnCount > 1) parts.push(`${runningSpawnCount} active`);
  const tokenCount = totalWorkflowTokens(details);
  if (tokenCount > 0) parts.push(formatCompactTokens(tokenCount));
  const duration = formatCompactDuration(
    details.run.startedAt,
    details.run.completedAt,
  );
  if (duration) parts.push(duration);
  return parts;
}

function renderWorkflowSummaryLines(
  details: RunResultDetails,
  theme: Theme,
  spinner = currentSpinnerFrame(),
): string[] {
  const focus = selectRepresentativeSpawnNode(details);
  const parts = workflowBadgeParts(details, focus);
  const label = workflowPrimaryLabel(details, focus);
  const status = details.run.status;
  if (status === "stopped") {
    parts.unshift(formatRunStatus(details.run));
  }
  const icon =
    status === "running"
      ? theme.fg("accent", spinner)
      : status === "completed"
        ? theme.fg("success", "✓")
        : details.run.error
          ? theme.fg("error", "✗")
          : theme.fg("warning", "■");
  const peek =
    workflowPreviewLine(details, focus) ??
    (status === "running"
      ? "working…"
      : status === "completed"
        ? "Done"
        : "Stopped");
  const summaryText = [label, ...parts].filter(Boolean).join(" · ");
  return [`${icon} ${summaryText}`, theme.fg("dim", `  ⎿  ${peek}`)];
}

function renderAgentSummaryLines(
  details: AgentRunDetails,
  output: string,
  isPartial: boolean,
  theme: Theme,
): string[] {
  const status =
    details.status ??
    (isPartial
      ? "running"
      : details.stopReason === "background"
        ? "background"
        : details.exitCode === 0
          ? "completed"
          : "stopped");
  const icon =
    status === "running"
      ? theme.fg("accent", currentSpinnerFrame())
      : status === "completed"
        ? theme.fg("success", "✓")
        : status === "background"
          ? theme.fg("muted", "◌")
          : details.errorMessage
            ? theme.fg("error", "✗")
            : theme.fg("warning", "■");
  const parts = [
    theme.bold(details.agent),
    shortenModelName(details.model)
      ? theme.fg("dim", shortenModelName(details.model) as string)
      : undefined,
    details.thinking
      ? theme.fg("dim", `thinking: ${details.thinking}`)
      : undefined,
    details.usage.contextTokens > 0
      ? theme.fg("dim", formatCompactTokens(details.usage.contextTokens))
      : undefined,
    formatCompactDuration(details.startedAt, details.completedAt)
      ? theme.fg(
          "dim",
          formatCompactDuration(
            details.startedAt,
            details.completedAt,
          ) as string,
        )
      : undefined,
  ].filter(Boolean);
  const peek =
    status === "background"
      ? "Standing by for results."
      : (details.preview ??
        extractPreviewLine(output) ??
        (status === "running"
          ? "working…"
          : status === "completed"
            ? "Done"
            : (details.errorMessage ?? "Stopped")));
  return [
    `${icon} ${parts.join(` ${theme.fg("dim", "·")} `)}`,
    theme.fg("dim", `  ⎿  ${peek}`),
  ];
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

function pushPreviewSection(
  lines: string[],
  title: string,
  body: string | undefined,
  expanded: boolean,
  maxLines: number,
  theme: Theme,
): void {
  if (!body) {
    return;
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(theme.fg("toolTitle", theme.bold(title)));

  const preview = previewText(body, expanded, maxLines);
  const previewLines = preview.split("\n");
  const truncated = isPreviewTruncated(body, expanded, maxLines);

  for (const [index, line] of previewLines.entries()) {
    const isMoreLines = truncated && index === previewLines.length - 1;
    lines.push(theme.fg(isMoreLines ? "dim" : "toolOutput", line));
  }

  if (body.split("\n").length > maxLines) {
    lines.push(
      `(${notificationKeyHint(theme, expanded ? "to collapse" : "to expand")})`,
    );
  }
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
    args.scope && args.scope !== "both" ? `scope=${args.scope}` : undefined,
    args.cwd ? `cwd=${args.cwd}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (metadata) {
    lines.push(theme.fg("muted", metadata));
  }
  pushPreviewSection(lines, "Task", args.task, false, 6, theme);
  return createRenderer(lines);
}

export function renderAgentResult(
  result: AgentToolResult<AgentRunDetails>,
  expanded: boolean,
  isPartialOrTheme: boolean | Theme,
  maybeTheme?: Theme,
) {
  const isPartial =
    typeof isPartialOrTheme === "boolean" ? isPartialOrTheme : false;
  const theme = (
    typeof isPartialOrTheme === "boolean" ? maybeTheme : isPartialOrTheme
  ) as Theme;
  const details = result.details;
  if (details.status === "background") {
    return createRenderer([]);
  }
  const rawOutput = extractTextContent(result);
  const output = rawOutput ? stripResultXmlEnvelope(rawOutput) : rawOutput;
  const hasCompactSummary =
    isPartial ||
    Boolean(details.status || details.startedAt || details.preview);

  if (hasCompactSummary) {
    const lines = renderAgentSummaryLines(details, output, isPartial, theme);
    if (!isPartial && output) {
      pushPreviewSection(lines, "Output", output, expanded, 10, theme);
    }
    if (expanded && details.missingSkills.length > 0) {
      pushSection(
        lines,
        "Missing skills",
        details.missingSkills.join(", "),
        theme,
      );
    }
    if (expanded && details.discoveryDiagnostics.length > 0) {
      pushSection(
        lines,
        "Discovery diagnostics",
        details.discoveryDiagnostics.join("\n"),
        theme,
      );
    }
    return createRenderer(lines);
  }

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

  if (output) {
    pushPreviewSection(lines, "Output", output, expanded, 10, theme);
  }
  return createRenderer(lines);
}

export function renderWorkflowCall(args: WorkflowParams, theme: Theme) {
  const normalized = (() => {
    try {
      return normalizeWorkflowParams(args as unknown);
    } catch {
      return args;
    }
  })();

  const lines = [
    theme.fg(
      "toolTitle",
      theme.bold(normalized.label ? `flow ${normalized.label}` : "flow"),
    ),
  ];
  const metadata = [
    normalized.scope && normalized.scope !== "both"
      ? `scope=${normalized.scope}`
      : undefined,
    normalized.cwd ? `cwd=${normalized.cwd}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (metadata) {
    lines.push(theme.fg("muted", metadata));
  }

  const tree = formatFlowTree(normalized.flow, undefined, undefined, theme);
  if (tree.length > 0) {
    for (const treeLine of tree) {
      lines.push(treeLine);
    }
  }

  if (normalized.budgets) {
    pushSection(lines, "Budgets", formatOutput(normalized.budgets), theme);
  }
  return createRenderer(lines);
}

export function renderWorkflowResult(
  result: AgentToolResult<RunResultDetails>,
  expanded: boolean,
  isPartialOrTheme: boolean | Theme,
  maybeTheme?: Theme,
) {
  const isPartial =
    typeof isPartialOrTheme === "boolean" ? isPartialOrTheme : false;
  const theme = (
    typeof isPartialOrTheme === "boolean" ? maybeTheme : isPartialOrTheme
  ) as Theme;
  const details = result.details;
  if (isPartial || details.run.status === "running") {
    return createRenderer([]);
  }
  const lines = renderWorkflowSummaryLines(details, theme);

  lines.push("");
  lines.push(
    theme.fg(
      "muted",
      expanded
        ? `run=${details.run.id.slice(0, 8)} · nodes=${details.nodes.length} · scope=${details.run.scope}`
        : `run=${details.run.id.slice(0, 8)}`,
    ),
  );

  const output = details.result
    ? expanded
      ? formatOutput(details.result.output)
      : (summarizeStructuredWorkflowOutput(details.result.output) ??
        formatOutput(details.result.output))
    : stripResultXmlEnvelope(extractTextContent(result));
  if (output) {
    pushPreviewSection(lines, "Result", output, expanded, 12, theme);
  }
  if (details.run.error && expanded) {
    pushSection(lines, "Error", details.run.error, theme);
  }
  return createRenderer(lines);
}

function notificationStatusTone(
  status: RunNotificationDetails["status"],
): "success" | "warning" | "error" | "accent" {
  switch (status) {
    case "completed":
      return "success";
    case "stopped":
      return "warning";
  }
}

function formatNotificationTitle(details: RunNotificationDetails): string {
  const icon = iconForStatus(details.status);
  if (details.kind === "spawn_update") {
    return `${icon} ${details.runLabel} · ${details.nodeLabel}`;
  }
  return `${icon} ${details.runLabel}`;
}

function formatNotificationBody(details: RunNotificationDetails): string[] {
  const lines: string[] = [];

  if (details.kind === "spawn_update" && details.agent) {
    lines.push(`agent=${details.agent}`);
  }

  lines.push(`run=${details.runId.slice(0, 8)}`);

  if (details.kind === "spawn_update") {
    lines.push(`node=${details.nodeId}`);
  }

  if (details.summary) {
    lines.push("");
    lines.push(details.summary);
  }
  if (details.error) {
    lines.push("");
    lines.push(details.error);
  }

  if (details.kind === "run_final") {
    lines.push("");
    lines.push(`Use /flow ${details.runId} to inspect the full run.`);
  }

  return lines;
}

export function formatRunNotificationContent(
  details: RunNotificationDetails,
): string {
  return [formatNotificationTitle(details), ...formatNotificationBody(details)]
    .join("\n")
    .trim();
}

export function summarizeWorkflowOutput(value: unknown): string | undefined {
  return summarizeStructuredWorkflowOutput(value) ?? firstMeaningfulLine(value);
}

function canExpandRunNotification(details: RunNotificationDetails): boolean {
  if (details.kind === "run_final") return true;
  if (details.agent || details.error) return true;
  if (details.summary && details.summary.split("\n").length > 4) return true;
  return false;
}

function notificationKeyHint(theme: Theme, description: string): string {
  return (
    theme.fg("dim", editorKey("expandTools")) +
    theme.fg("muted", ` ${description}`)
  );
}

export function renderRunNotificationMessage(
  message: RenderableCustomMessage<RunNotificationDetails>,
  options: { expanded: boolean },
  theme: Theme,
) {
  const details = message.details;
  if (!details) {
    return new Text(String(message.content), 0, 0);
  }

  const lines = [
    theme.fg(
      notificationStatusTone(details.status),
      theme.bold(formatNotificationTitle(details)),
    ),
  ];

  if (options.expanded) {
    lines.push(...formatNotificationBody(details));
    lines.push("");
    lines.push(
      theme.fg("dim", new Date(details.timestamp).toLocaleTimeString()),
    );
    if (canExpandRunNotification(details)) {
      lines.push(`(${notificationKeyHint(theme, "to collapse")})`);
    }
  } else if (details.error) {
    lines.push(theme.fg("error", previewText(details.error, false, 4)));
  } else if (details.summary) {
    lines.push(theme.fg("toolOutput", previewText(details.summary, false, 4)));
  } else if (details.kind === "run_final") {
    lines.push(theme.fg("dim", `Use /flow ${details.runId} to inspect.`));
  }
  if (!options.expanded && canExpandRunNotification(details)) {
    lines.push(`(${notificationKeyHint(theme, "to expand")})`);
  }

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
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
  runEventCache?: RunEventCache,
  liveRuns?: LiveRunRegistry,
): void {
  const sessionManager = ctx.sessionManager;
  const branchEntries =
    typeof sessionManager?.getBranch === "function"
      ? sessionManager.getBranch()
      : [];
  const sessionFile =
    typeof sessionManager?.getSessionFile === "function"
      ? sessionManager.getSessionFile()
      : undefined;
  const mergedEntries = runEventCache
    ? runEventCache.mergeEntries(sessionFile, branchEntries as SessionEntry[])
    : branchEntries;
  const rebuilt = rebuildRunState(mergedEntries);
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
  markRunningRunsStopped(runtimeState);
  for (const snapshot of liveRuns?.listSnapshots() ?? []) {
    runtimeState.runs.set(snapshot.run.id, structuredClone(snapshot.run));
    for (const node of snapshot.nodes) {
      runtimeState.nodes.set(node.id, structuredClone(node));
    }
    if (!runtimeState.order.includes(snapshot.run.id)) {
      runtimeState.order.push(snapshot.run.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Live widget — timer-driven animated flow tree
// ---------------------------------------------------------------------------

/** Braille spinner frames (same sequence as pi's built-in Loader). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner cadence for flow summaries and the widget. */
const FLOW_SUMMARY_TICK_MS = 80;

/** Maximum widget body lines before truncation. */
const MAX_WIDGET_LINES = 10;

/** Keep widget headers short because the tree below already carries detail. */
const MAX_WIDGET_LABEL_LENGTH = 36;

function compactWidgetLabel(label: string): string {
  const trimmed = label.trim();
  const preferred = trimmed.split(":", 1)[0]?.trim() || trimmed;
  if (preferred.length <= MAX_WIDGET_LABEL_LENGTH) return preferred;
  return `${preferred.slice(0, MAX_WIDGET_LABEL_LENGTH - 1).trimEnd()}…`;
}

function isTrivialWidgetFlow(run: WorkflowRun): boolean {
  return (
    run.flow.kind === "spawn" ||
    (run.flow.kind === "sequence" &&
      run.flow.steps.length === 1 &&
      run.flow.steps[0]?.kind === "spawn")
  );
}

function renderWidgetRunHeader(
  details: RunResultDetails,
  theme: Theme,
  spinner: string,
): string {
  const parts = workflowBadgeParts(
    details,
    selectRepresentativeSpawnNode(details),
  );
  const summaryText = [compactWidgetLabel(details.run.label), ...parts]
    .filter(Boolean)
    .join(" · ");
  return `${theme.fg("accent", spinner)} ${summaryText}`;
}

/**
 * Build themed widget lines for live runs.
 *
 * The widget is only shown while flows are still running. Final summaries are
 * rendered in the conversation instead of lingering above the editor.
 */
export function buildWidgetLines(
  runtimeState: RunRuntimeState,
  spinner: string,
  theme: Theme,
  terminalWidth: number,
): string[] {
  const orderedRuns = getOrderedRuns(runtimeState);
  const runningRuns = orderedRuns.filter((run) => run.status === "running");
  if (runningRuns.length === 0) return [];

  const runs = runningRuns.slice(0, 5);

  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const hasActive = true;
  const headingTone = hasActive ? "accent" : "dim";
  const headingIcon = hasActive ? "●" : "○";

  const lines: string[] = [
    `${theme.fg(headingTone, headingIcon)} ${theme.fg(headingTone, "Flows")}`,
  ];

  for (const [index, run] of runs.entries()) {
    const snapshot = getRunSnapshot(runtimeState, run.id);
    if (!snapshot) continue;
    const isLast = index === runs.length - 1;
    const connector = isLast ? "└─" : "├─";
    const indent = isLast ? "   " : "│  ";

    lines.push(
      truncate(
        `${theme.fg("dim", connector)} ${renderWidgetRunHeader(snapshot, theme, spinner)}`,
      ),
    );

    if (isTrivialWidgetFlow(run)) {
      continue;
    }

    const tree = formatFlowTree(run.flow, runtimeState, run.id, theme)
      .slice(1)
      .map((line) => line.replaceAll(iconForStatus("running"), spinner));
    for (const treeLine of tree) {
      lines.push(truncate(`${theme.fg("dim", indent)}${treeLine}`));
    }
  }

  if (lines.length > MAX_WIDGET_LINES) {
    const hidden = lines.length - MAX_WIDGET_LINES + 1;
    lines.length = MAX_WIDGET_LINES - 1;
    lines.push(theme.fg("dim", `└─ +${hidden} more…`));
  }

  return lines;
}

export function formatRunStatus(run: { status: string }): string {
  return run.status;
}

/**
 * Manages the live widget timer for active runs.
 *
 * Uses the same cadence as pi's public Loader component to rotate the
 * spinner and re-render the widget through `setWidget`'s
 * `{ render, invalidate }` callback API.
 */
export class RunWidgetManager {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastCtx: ExtensionContext | undefined;

  constructor(private runtimeState: RunRuntimeState) {}

  update(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    if (!ctx.hasUI || !ctx.ui) return;

    const runs = getOrderedRuns(this.runtimeState).filter(
      (run) => run.status === "running",
    );

    if (runs.length === 0) {
      this.stop(ctx);
      return;
    }

    if (!this.interval) {
      this.interval = setInterval(() => this.tick(), FLOW_SUMMARY_TICK_MS);
    }

    this.render(ctx);
  }

  private tick(): void {
    this.frame += 1;
    if (this.lastCtx?.hasUI && this.lastCtx.ui) {
      this.render(this.lastCtx);
    }
  }

  private render(ctx: ExtensionContext): void {
    if (!ctx.ui) return;
    const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "⠹";

    ctx.ui.setWidget(
      "pi-agents-runs",
      (_tui, theme) => {
        const w = _tui.terminal?.columns ?? 120;
        const lines = buildWidgetLines(this.runtimeState, spinner, theme, w);
        return { render: () => lines, invalidate: () => {} };
      },
      { placement: "aboveEditor" },
    );
  }

  private stop(ctx: ExtensionContext): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    ctx.ui?.setWidget("pi-agents-runs", undefined);
  }
}
