/**
 * The model-facing `workflow_create` tool: starts either a saved workflow by
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
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import {
  type Budgets,
  effectiveScope,
  normalizeDisplayPath,
  type Scope,
} from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { truncateModelResult, valueText } from "../model/value.js";
import type { RunStatus } from "../run/events.js";
import type { RunOutcome } from "../run/interpreter.js";
import { isProjectTrusted } from "../run/persist.js";
import {
  formatUsage,
  formatWorkflowCallPreview,
  formatWorkflowResultPreview,
  shortId,
  type WorkflowPreviewColorize,
  type WorkflowPreviewState,
} from "../ui/render.js";
import { renderWorkflowTree } from "../ui/tree.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

/**
 * Delegation is expensive and surprising when unasked for, so the tool is
 * opt-in and this gate opens its description. It enumerates the admissible
 * triggers positively and then names the plausible near-misses explicitly,
 * because "would benefit from parallelism" is exactly the inference that
 * produces unwanted runs.
 *
 * The first two promptGuidelines restate this rule for the system prompt's
 * Guidelines section; they are worded separately rather than sharing this
 * text, which is scoped to the tool schema. Keep the two in sync.
 */
const USE_GATE = `USE ONLY ON EXPLICIT REQUEST — this tool is opt-in, and it only ever STARTS a new run. Call it only when the user affirmatively asked to run one: "run the review workflow", "delegate this", "spawn agents for these", "do these in parallel", "kick off <name>". A saved workflow from <workflows> qualifies only when the user asked for it to run — by name, or by describing the situation its <trigger> declares.

Mentioning "workflow" or "flow" is not a request; neither is asking about a saved workflow, reading one, editing one, or discussing this algebra — in a conversation about workflows those words appear constantly. Nothing else is a trigger either: not a large multi-step task, a long list of independent items, a multi-file refactor, a review, an audit, a research question, or a task you judge parallelizable. Do that work yourself. If a workflow seems better but was not requested, do the work directly and say so in one sentence — do not call the tool to make the offer concrete.

For a run that already exists, never call this tool: use workflow_list, workflow_inspect, workflow_result, or workflow_stop.`;

const FLOW_REFERENCE = `A flow is a JSON expression tree; every node yields a value. Node kinds:
- {"kind":"agent","task":"...","name":"...","json":{"type":"object","properties":{...},"required":[...],"additionalProperties":false},"model":"provider/id from <models> (bare id resolves to the earliest listed provider)","thinking":"...","skills":["..."],"tools":["..."],"cwd":"...","scope":"user"|"project"|"both"} — one delegated agent (leaf; a bare agent node is a valid flow). Omit "name" for an anonymous ad-hoc agent; set it only to use a profile from <agents>. Omit "json" for a string result; include a substantive JSON Schema Draft 7 object for a machine-readable result. Every execution option works with or without "name". "skills" is a closed selection: omit it on an anonymous call to retain ambient discovery, name exactly the skills to inject, or use [] to disable discovery. A named call inherits its profile's closed skill list unless the node replaces it. "tools" is a tool allowlist ([] means no tools) and likewise replaces a named profile's list.
- {"kind":"sequence","steps":[node,...]} — steps in order; value = the last step's.
- {"kind":"parallel","branches":{"a":node,...},"mode":"all"|"any"|{"quorum":n},"onError":"fail"|"collect","concurrency":n,"reduce":{"task":"merge {branches}","agent":"..."}} — concurrent branches; value = {branch: value}, or the winner's value for "any". A reduce spec takes the same execution options as an agent node ("agent" is its spelling of "name").
- {"kind":"map","over":"{binding}","body":node,"concurrency":n,"reduce":{"task":"merge {items}"}} — run body per element of the array {binding}; the body sees {item} and {index}; value = array of body values.
- {"kind":"loop","body":node,"max":n,"until":predicate} — bounded do-until: run body at least once (it sees {iteration} and {last}), then stop when the predicate holds over its JSON value.
- {"kind":"while","on":"{binding}","condition":predicate,"body":node,"max":n} — bounded pre-checked iteration: while the predicate holds over the carried value, run body with {current} and {iteration}; the body's value becomes the next current value. The node returns the current value without saying whether the condition failed or the cap was reached, so encode convergence in that value when the distinction matters. Predicates: {"eq":["path",value]}, "ne", "gt", "lt", {"exists":"path"}, {"empty":"path"}, "and", "or", "not".
- {"kind":"switch","on":"{binding}","cases":[{"when":predicate,"then":node},...],"else":node} — exclusive routing: first case whose predicate holds over the JSON value {binding} runs; "else" is required; value = the chosen arm's.
- {"kind":"value","value":json} — pure data leaf, no agent: strings are templates (a lone "{ref}" substitutes the JSON value itself; mixed text interpolates as a string); value = the interpolated JSON.
- {"kind":"workflow","name":"...","params":{"k":"v"}} — invoke a saved workflow.

Data flows ONLY through explicit references: "as":"x" names a step's value; later tasks reference {x} or {x.dot.path} (declare a "json" schema upstream for structured access); {previous} is the preceding step's value. Nothing flows implicitly. Invalid nodes fail with exact node-path errors — fix and retry.`;

/** The `flow` parameter defers to the tool description so the grammar is
 * sent once per request, not twice. */
export const FLOW_PARAM_DESCRIPTION =
  'Inline flow expression to run (instead of "name"). Node grammar: see the tool description.';

/**
 * Some tool-calling harnesses serialize loosely-typed parameters as JSON
 * text instead of structured objects. Accept a stringified flow by parsing
 * it back into a value before validation.
 */
export function coerceInlineFlow(flow: unknown): unknown {
  if (typeof flow !== "string") return flow;
  const trimmed = flow.trim();
  if (!trimmed.startsWith("{")) return flow;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `invalid flow: "flow" arrived as a string that is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

const WorkflowCreateParams = Type.Object({
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
      description: FLOW_PARAM_DESCRIPTION,
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short human-readable label for this run." }),
  ),
  display: Type.Optional(
    Type.String({
      description:
        "Dot path to a Markdown string in the final value for human-facing rendering. Numeric segments index arrays. Overrides a saved workflow's display path. The complete value remains available to machine consumers and workflow_result with view raw.",
    }),
  ),
  budgets: Type.Optional(
    Type.Object(
      {
        maxDepth: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum process depth allowed before an agent spawn. Integer >= 1; default 5.",
          }),
        ),
        maxParallelism: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum simultaneously running agents. Integer >= 1; default 8.",
          }),
        ),
        maxIterations: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum iterations allowed for each loop or while node. Integer >= 1; default 10.",
          }),
        ),
        maxAgents: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Total agent and reducer executions. Integer >= 0; default 50. Zero prohibits agent execution. Value and structural nodes do not consume this budget.",
          }),
        ),
        maxTurns: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum assistant turns per agent. Integer >= 1; default 250.",
          }),
        ),
        maxAgentDuration: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            description:
              "Maximum wall-clock seconds per agent. Must be > 0; unbounded when omitted.",
          }),
        ),
        maxDuration: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            description:
              "Maximum wall-clock seconds for the run. Must be > 0; unbounded when omitted.",
          }),
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum input and output tokens for the run, excluding cache traffic. Integer >= 1; unbounded when omitted.",
          }),
        ),
        maxCost: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            description:
              "Maximum run cost in USD. Must be > 0; unbounded when omitted.",
          }),
        ),
      },
      {
        description:
          "Optional execution limits. Omitted counting limits use their defaults; omitted duration, token, and cost limits are unbounded. Breaches fail the agent or run with the partial result preserved.",
      },
    ),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for delegated agents." }),
  ),
  scope: Type.Optional(
    StringEnum(["user", "project", "both"] as const, {
      description:
        "Discovery scope for agent profiles, skills, and saved workflows.",
      default: "both",
    }),
  ),
});

export type WorkflowCreateParamsType = Static<typeof WorkflowCreateParams>;

export interface WorkflowCreateDetails {
  runId: string;
  status: RunStatus;
  label?: string;
  error?: string;
}

/** Shared UI formatters for the workflow creation tool. */
export type ToolColorize = WorkflowPreviewColorize;
export type WorkflowCreateRenderState = WorkflowPreviewState;
export const formatCallPreview = formatWorkflowCallPreview;
export const formatResultPreview = formatWorkflowResultPreview;

/**
 * Resolve a saved workflow's expanded flow tree for display. Filesystem
 * discovery is not free, so callers memoize per tool call.
 */
export function resolveSavedFlowTree(
  name: string,
  cwd: string,
  color?: ToolColorize,
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
    return renderWorkflowTree(def.name, expanded, color);
  } catch {
    return undefined;
  }
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
    const value = truncateModelResult(
      valueText(outcome.value) ?? "",
      `workflow_result({run:"${shortId(runId)}",view:"raw"})`,
    );
    lines.push("<value>", value, "</value>");
  } else {
    lines.push("<error>", outcome.error ?? "unknown error", "</error>");
  }
  lines.push("</workflow-run>");
  return lines.join("\n");
}

export function createWorkflowCreateTool(
  deps: TriggerDeps,
): ToolDefinition<
  typeof WorkflowCreateParams,
  WorkflowCreateDetails,
  WorkflowCreateRenderState
> {
  return {
    name: "workflow_create",
    label: "Workflow Create",
    description: `Create a run of a multi-agent workflow of delegated pi agents.

${USE_GATE}

Once requested: pass EITHER "name" (+ "params") to run a saved workflow, OR "flow" for an inline expression. A top-level "display":"path.to.markdown" selects a string from the final value for human-facing Markdown rendering while preserving the complete value for the calling model, parent workflows, and raw inspection. ${FLOW_REFERENCE}`,
    promptSnippet:
      "Create a workflow run of delegated agents — only when the user explicitly asks for delegation",
    promptGuidelines: [
      'Do not call workflow_create unless the user affirmatively asked to run one — "run the X workflow", "delegate this", "spawn agents", "do these in parallel", or a saved workflow they asked for by name or by its <trigger> situation. Merely mentioning "workflow"/"flow", or asking about a saved workflow, is not a request. Otherwise do the task yourself.',
      "Size, step count, parallelizability, and review/refactor/audit/research shape are not triggers. When a workflow looks like a good fit but was not requested, do the work directly and offer it in one sentence instead of calling the tool.",
      "workflow_create only starts new runs. For an existing run, use workflow_list, workflow_inspect, workflow_result, or workflow_stop.",
      "Once a workflow is requested: prefer a saved workflow via workflow_create({name, params}) when one in <workflows> matches; otherwise compose an inline flow — a bare agent leaf for one isolated task, or sequence/parallel/map/loop/while for multi-agent work.",
      "Route deterministically with `switch` instead of asking an agent to decide: predicates over a JSON binding pick exactly one arm; use a `value` arm to yield data without spawning an agent.",
      "Omit the agent name for one-off delegation; it is only needed to select a reusable profile from <agents>. Never invent agent names or create agent-definition files merely to execute an ad-hoc flow — an anonymous node can select skills, tools, model, and thinking directly.",
      "Request a skill by name on the node that needs it. An unknown skill fails the run before anything spawns, so do not guess names; take them from <available_skills>.",
      "An unknown model fails the run before anything spawns; take identifiers from <models>.",
      'In flows, thread data explicitly: bind sequence steps with "as" and reference {name}/{previous} in later tasks; declare a concrete "json" schema when downstream steps need structured access.',
      "When workflow_create returns structured data with a human-readable Markdown field, set its top-level display to that field's dot path; display changes presentation only and preserves the complete result.",
    ],
    parameters: WorkflowCreateParams,
    renderCall(args, theme, context) {
      const color: ToolColorize = (name, text) => theme.fg(name, text);
      // Resolving a saved workflow's tree hits the filesystem; memoize per
      // tool call so redraws stay free.
      let savedFlowTree: string | undefined;
      if (args.name !== undefined && context.argsComplete) {
        let cached = context.state.savedFlowTree;
        if (cached === undefined) {
          cached = resolveSavedFlowTree(args.name, context.cwd, color) ?? null;
          context.state.savedFlowTree = cached;
        }
        savedFlowTree = cached ?? undefined;
      }
      const streamingState = context.argsComplete ? undefined : context.state;
      const callText =
        formatCallPreview(args, color, savedFlowTree, streamingState) ||
        "workflow_create";
      if (context.lastComponent instanceof Text) {
        if (context.state.callText !== callText) {
          context.lastComponent.setText(callText);
        }
        context.state.callText = callText;
        return context.lastComponent;
      }
      context.state.callText = callText;
      return new Text(callText, 1, 0);
    },
    renderResult(result, options, theme) {
      const color: ToolColorize = (name, text) => theme.fg(name, text);
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      // The stored tool result freezes at "running" for backgrounded runs;
      // consult the live run state so scrollback shows the actual outcome.
      const live = deps.manager.state.runs.get(result.details.runId);
      const details: WorkflowCreateDetails =
        live && live.status !== "running"
          ? {
              ...result.details,
              status: live.status,
              error: live.error ?? result.details.error,
            }
          : result.details;
      const preview = formatResultPreview(
        { details, text },
        options.expanded,
        color,
      );
      return preview ? new Text(preview, 1, 0) : new Container();
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
      const requestedDisplay = normalizeDisplayPath(params.display);
      let display = requestedDisplay;
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
        display = requestedDisplay ?? def.display;
      } else {
        raw = coerceInlineFlow(params.flow);
      }

      const flow = validateFlow(raw, { resolveWorkflow });
      // Interactive sessions background immediately: the tool returns right
      // away, progress shows in the widget, and the result arrives as an
      // idle notification. Headless modes stay foreground.
      // RPC exposes a UI bridge (`hasUI === true`) even though delegated
      // children have nobody to answer it. Only the interactive TUI should
      // background runs; print/JSON/RPC modes must await nested workflows.
      const background = ctx.mode === "tui";
      const { runId, done } = startTriggeredRun(deps, {
        flow,
        cwd,
        scope,
        label,
        display,
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
              text: `Started workflow run ${id}${label ? ` (${label})` : ""} in the background. End your turn now — do not wait for it. When the run finishes you will be re-invoked with its result to continue. Use workflow_inspect or workflow_result with run ${id} if you need to query it later.`,
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
