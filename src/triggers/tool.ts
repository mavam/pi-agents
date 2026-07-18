/**
 * The single model-facing `workflow` tool: runs either a saved workflow by
 * name (+ params) or an inline flow expression. A bare agent leaf is a valid
 * flow, so single delegation needs no separate tool.
 *
 * The `flow` parameter is deliberately loosely typed (recursive schemas break
 * some providers); validation happens in execute() with node-path errors.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import { type Budgets, effectiveScope, type Scope } from "../model/ast.js";
import { parseFlowNode, validateFlow } from "../model/validate.js";
import { MAX_PERSISTED_VALUE_CHARS, type RunStatus } from "../run/events.js";
import type { RunOutcome } from "../run/interpreter.js";
import { isProjectTrusted } from "../run/persist.js";
import { formatUsage, shortId } from "../ui/render.js";
import { KIND_ICONS, renderFlowTree } from "../ui/tree.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

const FLOW_REFERENCE = `A flow is a JSON expression tree; every node yields a value. Node kinds:
- {"kind":"agent","name":"<agent>","task":"...","output":"text"|"json","model":"...","thinking":"..."} — run one delegated agent (leaf). A bare agent node is a valid flow; model/thinking override the agent file.
- {"kind":"seq","steps":[node,...]} — run steps in order; value = last step's value.
- {"kind":"par","branches":{"a":node,...},"mode":"all"|"any"|{"quorum":n},"onError":"fail"|"collect","concurrency":n,"reduce":{"agent":"...","task":"merge {branches}"}} — run branches concurrently. Value: "all"/quorum → {branch: value}; "any" → the winner's value (siblings cancelled).
- {"kind":"map","over":"{binding}","body":node,"concurrency":n,"reduce":{"agent":"...","task":"merge {items}"}} — fan out body per element of the array {binding} resolves to; the body sees {item} and {index}. Value: array of body values.
- {"kind":"loop","body":node,"max":n,"until":predicate} — repeat body until the predicate holds over its JSON value; the body sees {iteration} and {last}. Predicates: {"eq":["path",value]}, {"ne":[..]}, {"gt":["path",n]}, {"lt":[..]}, {"exists":"path"}, {"empty":"path"}, {"and":[..]}, {"or":[..]}, {"not":..}.
- {"kind":"workflow","name":"<saved>","params":{"k":"v"}} — invoke a saved workflow.

Data flows ONLY through explicit references. Mark a seq step with "as":"name" and reference {name} or {name.dot.path} in later task strings; {previous} is the immediately preceding step's value. Use "output":"json" upstream when you need dot-path access or predicates. Nothing flows implicitly.`;

const WorkflowToolParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Name of a saved workflow to run (see <workflows> in the system prompt).",
    }),
  ),
  params: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Parameter values for the saved workflow (literal strings).",
    }),
  ),
  flow: Type.Optional(
    Type.Unknown({
      description: `Inline flow expression to run (instead of "name"). ${FLOW_REFERENCE}`,
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short human-readable label for this run." }),
  ),
  budgets: Type.Optional(
    Type.Object(
      {
        maxDepth: Type.Optional(Type.Number()),
        maxParallelism: Type.Optional(Type.Number()),
        maxIterations: Type.Optional(Type.Number()),
        maxAgents: Type.Optional(Type.Number()),
      },
      {
        description:
          "Execution budgets: maxDepth, maxParallelism, maxIterations, maxAgents.",
      },
    ),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for delegated agents." }),
  ),
  scope: Type.Optional(
    StringEnum(["user", "project", "both"] as const, {
      description: "Agent/workflow discovery scope.",
      default: "both",
    }),
  ),
});

export type WorkflowToolParamsType = Static<typeof WorkflowToolParams>;

export interface WorkflowToolDetails {
  runId: string;
  status: RunStatus;
  label?: string;
  error?: string;
}

/** Minimal color hook so the pure formatters are testable without a theme. */
export type ToolColorize = (
  color: "dim" | "accent" | "success" | "error",
  text: string,
) => string;

const plain: ToolColorize = (_color, text) => text;

const PARAM_PREVIEW_CHARS = 72;

/** Memoized saved-workflow trees for renderCall; null = resolution failed. */
const savedFlowTreeCache = new Map<string, string | null>();

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Resolve a saved workflow's expanded flow tree for display. Filesystem
 * discovery is not free, so callers memoize per tool call.
 */
export function resolveSavedFlowTree(
  name: string,
  cwd: string,
): string | undefined {
  try {
    const { workflows } = discoverWorkflows(cwd, "both");
    const def = resolveWorkflowByName(workflows, name);
    if (!def) return undefined;
    const expanded = validateFlow(structuredClone(def.flow) as unknown, {
      resolveWorkflow: (candidate) =>
        resolveWorkflowByName(workflows, candidate),
      selfName: def.name,
      params: def.params,
    });
    return renderFlowTree(expanded);
  } catch {
    return undefined;
  }
}

/**
 * Icon tree preview of the tool call — tolerant of partial/invalid args.
 * One header line (icon, name, dim label), params each on their own dim
 * line, then the full vertical structure (resolved by the caller for saved
 * workflows, parsed from args for inline flows).
 */
export function formatCallPreview(
  params: WorkflowToolParamsType,
  color: ToolColorize = plain,
  savedFlowTree?: string,
): string {
  const lines: string[] = [];
  const label = params.label ? color("dim", ` · ${params.label}`) : "";
  try {
    if (params.name !== undefined) {
      lines.push(`${KIND_ICONS.workflow} ${params.name}${label}`);
      for (const [key, value] of Object.entries(params.params ?? {})) {
        lines.push(
          color("dim", `   ${key}: ${oneLine(value, PARAM_PREVIEW_CHARS)}`),
        );
      }
      if (savedFlowTree) lines.push(savedFlowTree);
    } else if (params.flow !== undefined) {
      if (params.label) lines.push(color("dim", params.label));
      const issues: { path: string; message: string }[] = [];
      const parsed = parseFlowNode(params.flow, "$", issues);
      if (parsed && issues.length === 0) {
        lines.push(renderFlowTree(parsed));
      } else {
        lines.push(`${JSON.stringify(params.flow)?.slice(0, 200) ?? ""}…`);
      }
    }
  } catch {
    // Streaming args may be incomplete; the default renderer takes over.
  }
  return lines.join("\n");
}

/**
 * The user-facing result line. The tool's content string stays model-facing
 * (it carries the continuation instruction); this is what the human sees.
 */
export function formatResultPreview(
  result: { details: WorkflowToolDetails; text: string },
  expanded: boolean,
  color: ToolColorize = plain,
): string {
  const { runId, status, error } = result.details;
  const id = shortId(runId);
  // The call render above already shows the label and structure; this line
  // carries only status and the one actionable reference.
  if (status === "running") {
    return `${color("accent", "◉")} running in background ${color("dim", `· /run ${id}`)}`;
  }
  if (status === "completed") {
    const head = `${color("success", "●")} completed ${color("dim", `· /run ${id} result`)}`;
    return expanded ? `${head}\n${result.text}` : head;
  }
  const head = `${color("error", "✗")} ${status}${error ? ` ${color("dim", `— ${oneLine(error, 120)}`)}` : ""} ${color("dim", `· /run ${id}`)}`;
  return expanded ? `${head}\n${result.text}` : head;
}

export function formatRunResult(
  runId: string,
  label: string | undefined,
  outcome: RunOutcome,
): string {
  const lines: string[] = [];
  const usage = formatUsage(outcome.usage);
  lines.push(
    `<workflow-run id="${shortId(runId)}" status="${outcome.status}"${label ? ` label="${label}"` : ""}${
      usage ? ` usage="${usage} ${outcome.agents} agent(s)"` : ""
    }>`,
  );
  if (outcome.status === "completed") {
    const full =
      typeof outcome.value === "string"
        ? outcome.value
        : (JSON.stringify(outcome.value, null, 2) ?? "");
    // Bound what flows back into the model's context; the full value stays
    // retrievable via /run <id> result.
    const value =
      full.length > MAX_PERSISTED_VALUE_CHARS
        ? `${full.slice(0, MAX_PERSISTED_VALUE_CHARS)}\n… [truncated ${full.length - MAX_PERSISTED_VALUE_CHARS} characters; full result: /run ${shortId(runId)} result]`
        : full;
    lines.push("<value>", value, "</value>");
  } else {
    lines.push("<error>", outcome.error ?? "unknown error", "</error>");
  }
  lines.push("</workflow-run>");
  return lines.join("\n");
}

export function createWorkflowTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowToolParams, WorkflowToolDetails> {
  return {
    name: "workflow",
    label: "Workflow",
    description: `Run a multi-agent workflow of delegated pi agents. Pass EITHER "name" (+ "params") to run a saved workflow, OR "flow" for an inline expression. ${FLOW_REFERENCE}`,
    promptSnippet:
      "workflow: delegate work to isolated agents — a single agent leaf, or a composition (seq/par/map/loop) of them",
    promptGuidelines: [
      "Prefer the `workflow` tool for delegation: a bare agent leaf for one isolated task, seq/par/map/loop compositions for multi-agent work.",
      "Check <workflows> in the system prompt first; prefer a saved workflow via workflow({name, params}) when one matches the request.",
      'In flows, thread data explicitly: bind seq steps with "as" and reference {name}/{previous} in later tasks; use output:"json" when downstream steps need structured access.',
    ],
    parameters: WorkflowToolParams,
    renderCall(args, theme, context) {
      const color: ToolColorize = (name, text) => theme.fg(name, text);
      // Resolving a saved workflow's tree hits the filesystem; memoize per
      // tool call so redraws stay free.
      let savedFlowTree: string | undefined;
      if (args.name !== undefined && context?.argsComplete) {
        // Keyed by tool call: each invocation resolves once, so redraws are
        // free but a later call sees fresh file contents.
        const key = context.toolCallId;
        let cached = savedFlowTreeCache.get(key);
        if (cached === undefined) {
          if (savedFlowTreeCache.size > 200) savedFlowTreeCache.clear();
          cached = resolveSavedFlowTree(args.name, context.cwd) ?? null;
          savedFlowTreeCache.set(key, cached);
        }
        savedFlowTree = cached ?? undefined;
      }
      const previewText = formatCallPreview(args, color, savedFlowTree);
      return new Text(previewText || "workflow", 1, 0);
    },
    renderResult(result, options, theme) {
      const color: ToolColorize = (name, text) => theme.fg(name, text);
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(
        formatResultPreview(
          { details: result.details, text },
          options.expanded,
          color,
        ),
        1,
        0,
      );
    },
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const provided = [
        params.name !== undefined,
        params.flow !== undefined,
      ].filter(Boolean).length;
      if (provided !== 1) {
        throw new Error(
          'pass exactly one of "name" (saved workflow) or "flow" (inline expression)',
        );
      }
      const cwd = params.cwd ?? ctx.cwd;
      const trusted = isProjectTrusted(ctx);
      if (!trusted && params.scope === "project") {
        throw new Error(
          "scope 'project' is unavailable: this project is not trusted, so project-local agents and workflows cannot run",
        );
      }
      const scope = effectiveScope(params.scope as Scope | undefined, trusted);
      const { workflows } = discoverWorkflows(cwd, scope);
      const resolveWorkflow = (name: string) =>
        resolveWorkflowByName(workflows, name);

      let raw: unknown;
      let label = params.label;
      if (params.name !== undefined) {
        const def = resolveWorkflow(params.name);
        if (!def) {
          const available = workflows.map((wf) => wf.name).join(", ") || "none";
          throw new Error(
            `unknown workflow '${params.name}'. Available: ${available}`,
          );
        }
        raw = { kind: "workflow", name: def.name, params: params.params ?? {} };
        label = label ?? def.name;
      } else {
        raw = params.flow;
      }

      const flow = validateFlow(raw, { resolveWorkflow });
      // Interactive sessions background immediately: the tool returns right
      // away, progress shows in the widget, and the result arrives as an
      // idle notification. Headless (-p) runs stay foreground.
      const background = ctx.hasUI === true;
      const { runId, done } = startTriggeredRun(deps, {
        flow,
        cwd,
        scope,
        label,
        budgets: params.budgets as Budgets | undefined,
        source: { kind: "tool", workflow: params.name },
        ctx,
        background,
      });

      if (background) {
        const id = shortId(runId);
        return {
          content: [
            {
              type: "text",
              text: `Started workflow run ${id}${label ? ` (${label})` : ""} in the background. The result will arrive as a notification; the user can inspect it with /run ${id}. End your turn now — do not wait for it.`,
            },
          ],
          details: { runId, status: "running", label },
          terminate: true,
        };
      }

      const onAbort = () => deps.manager.stop(runId);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const outcome = await done;
        return {
          content: [
            { type: "text", text: formatRunResult(runId, label, outcome) },
          ],
          details: {
            runId,
            status: outcome.status,
            label,
            error: outcome.error,
          },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
