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
import { truncateModelResult, valueText } from "../model/value.js";
import type { RunStatus } from "../run/events.js";
import type { RunOutcome } from "../run/interpreter.js";
import { isProjectTrusted } from "../run/persist.js";
import { MAX_STEERING_MESSAGE_CHARS } from "../run/runs.js";
import { formatUsage, shortId } from "../ui/render.js";
import { STATUS_STYLES } from "../ui/status.js";
import { KIND_ICONS, renderFlowTree } from "../ui/tree.js";
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

For a run that already exists, never call this tool: steer a live agent with \`steer\`, and point the user at /workflow <run-id> to inspect or stop one.`;

const FLOW_REFERENCE = `A flow is a JSON expression tree; every node yields a value. Node kinds:
- {"kind":"agent","task":"...","name":"...","output":"text"|"json","model":"...","thinking":"...","skills":["..."],"tools":["..."],"cwd":"...","scope":"user"|"project"|"both"} — one delegated agent (leaf; a bare agent node is a valid flow). Omit "name" for an anonymous ad-hoc agent; set it only to use a profile from <agents>. Every execution option works with or without "name". "skills" is a closed selection: omit it on an anonymous call to retain ambient discovery, name exactly the skills to inject, or use [] to disable discovery. A named call inherits its profile's closed skill list unless the node replaces it. "tools" is a tool allowlist ([] means no tools) and likewise replaces a named profile's list.
- {"kind":"sequence","steps":[node,...]} — steps in order; value = the last step's.
- {"kind":"parallel","branches":{"a":node,...},"mode":"all"|"any"|{"quorum":n},"onError":"fail"|"collect","concurrency":n,"reduce":{"task":"merge {branches}","agent":"..."}} — concurrent branches; value = {branch: value}, or the winner's value for "any". A reduce spec takes the same execution options as an agent node ("agent" is its spelling of "name").
- {"kind":"map","over":"{binding}","body":node,"concurrency":n,"reduce":{"task":"merge {items}"}} — run body per element of the array {binding}; the body sees {item} and {index}; value = array of body values.
- {"kind":"loop","body":node,"max":n,"until":predicate} — bounded do-until: run body at least once (it sees {iteration} and {last}), then stop when the predicate holds over its JSON value.
- {"kind":"while","on":"{binding}","condition":predicate,"body":node,"max":n} — bounded pre-checked iteration: while the predicate holds over the carried value, run body with {current} and {iteration}; the body's value becomes the next current value. The node returns the current value without saying whether the condition failed or the cap was reached, so encode convergence in that value when the distinction matters. Predicates: {"eq":["path",value]}, "ne", "gt", "lt", {"exists":"path"}, {"empty":"path"}, "and", "or", "not".
- {"kind":"switch","on":"{binding}","cases":[{"when":predicate,"then":node},...],"else":node} — exclusive routing: first case whose predicate holds over the JSON value {binding} runs; "else" is required; value = the chosen arm's.
- {"kind":"value","value":json} — pure data leaf, no agent: strings are templates (a lone "{ref}" substitutes the JSON value itself; mixed text interpolates as a string); value = the interpolated JSON.
- {"kind":"workflow","name":"...","params":{"k":"v"}} — invoke a saved workflow.

Data flows ONLY through explicit references: "as":"x" names a step's value; later tasks reference {x} or {x.dot.path} (set "output":"json" upstream for structured access); {previous} is the preceding step's value. Nothing flows implicitly. Invalid nodes fail with exact node-path errors — fix and retry.`;

/** The `flow` parameter defers to the tool description so the grammar is
 * sent once per request, not twice. */
export const FLOW_PARAM_DESCRIPTION =
  'Inline flow expression to run (instead of "name"). Node grammar: see the tool description.';

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
      description: FLOW_PARAM_DESCRIPTION,
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short human-readable label for this run." }),
  ),
  budgets: Type.Optional(
    Type.Object(
      {
        maxDepth: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum cross-process delegation depth. Integer >= 1; default 5.",
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
              "Maximum assistant turns per agent. Integer >= 1; default 100.",
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

export type WorkflowToolParamsType = Static<typeof WorkflowToolParams>;

export interface WorkflowToolDetails {
  runId: string;
  status: RunStatus;
  label?: string;
  error?: string;
}

const SteerToolParams = Type.Object({
  run: Type.String({
    description: "Full workflow run id or unique id prefix.",
  }),
  instance: Type.Optional(
    Type.String({
      description:
        "Exact live node instance. Omit only when the run has one steerable agent.",
    }),
  ),
  message: Type.String({
    description: `Course correction to queue for the delegated agent (maximum ${MAX_STEERING_MESSAGE_CHARS} characters).`,
  }),
});

interface SteerToolDetails {
  runId: string;
  instance: string;
}

/** Model-facing control for a live background agent. */
export function createSteerTool(
  deps: TriggerDeps,
): ToolDefinition<typeof SteerToolParams, SteerToolDetails> {
  return {
    name: "steer",
    label: "Steer",
    description:
      "Queue a course correction for one agent in a live background workflow run. The message is delivered after the agent's current assistant turn finishes its tool calls. If several agents are running, pass an exact instance returned by the error message or /workflow <run-id> inspection.",
    promptSnippet:
      "steer: correct the course of one agent in a live background workflow run",
    promptGuidelines: [
      "Use steer only for a run that is already live; it never starts, restarts, or resumes an agent.",
      "Omit instance only when exactly one agent in the run is currently steerable.",
    ],
    parameters: SteerToolParams,
    async execute(_toolCallId, params) {
      const lookup = deps.manager.find(params.run);
      if (lookup.kind === "missing") {
        throw new Error(`No run matching '${params.run}'.`);
      }
      if (lookup.kind === "ambiguous") {
        throw new Error(
          `Ambiguous run id '${params.run}': ${lookup.matches.map((run) => shortId(run.header.id)).join(", ")}`,
        );
      }
      const runId = lookup.run.header.id;
      const available = deps.manager.steerableInstances(runId);
      const instance =
        params.instance ?? (available.length === 1 ? available[0] : undefined);
      if (!instance || !available.includes(instance)) {
        const choices = available.length > 0 ? available.join(", ") : "none";
        throw new Error(
          params.instance
            ? `Instance '${params.instance}' is not steerable. Available: ${choices}`
            : `Run ${shortId(runId)} has ${available.length} steerable instances. Specify one of: ${choices}`,
        );
      }
      const result = await deps.manager.steer(
        runId,
        instance,
        params.message,
        "tool",
      );
      if (result.status !== "queued") {
        throw new Error(
          result.status === "rejected"
            ? result.error
            : result.reason === "run_not_live"
              ? `Run ${shortId(runId)} is not live.`
              : `Instance '${instance}' is no longer steerable.`,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Steering queued for ${instance} in run ${shortId(runId)}. It will be delivered after the current assistant turn finishes its tool calls.`,
          },
        ],
        details: { runId, instance },
      };
    },
  };
}

/** Minimal color hook so the pure formatters are testable without a theme. */
export type ToolColorize = (
  color: "dim" | "accent" | "success" | "warning" | "error" | "muted",
  text: string,
) => string;

const plain: ToolColorize = (_color, text) => text;

const PARAM_PREVIEW_CHARS = 72;

/** Per-tool-row state shared across workflow call renders. */
export interface WorkflowToolRenderState {
  /** Last successfully rendered inline flow tree. */
  lastValidFlowTree?: string;
  /** Memoized saved-workflow tree; null means resolution failed. */
  savedFlowTree?: string | null;
  /** Text currently held by the reusable call component. */
  callText?: string;
}

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
    return renderFlowTree(expanded, color);
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
  streamingState?: WorkflowToolRenderState,
): string {
  const lines: string[] = [];
  const label = params.label ? color("dim", ` · ${params.label}`) : "";
  try {
    if (params.name !== undefined) {
      lines.push(
        `${color("muted", KIND_ICONS.workflow)} ${params.name}${label}`,
      );
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
        const tree = renderFlowTree(parsed, color);
        if (streamingState) streamingState.lastValidFlowTree = tree;
        lines.push(tree);
      } else if (streamingState?.lastValidFlowTree) {
        lines.push(streamingState.lastValidFlowTree);
      } else if (!streamingState) {
        lines.push(`${JSON.stringify(params.flow)?.slice(0, 200) ?? ""}…`);
      }
    }
  } catch {
    // Streaming args may be incomplete; the caller supplies a stable fallback.
  }
  return lines.join("\n");
}

/**
 * The user-facing result line — blank-line separated from the tree so it
 * reads as run metadata, not another node of the algebra. While the run is
 * live the widget below carries all liveness, so this line is icon-less and
 * fully dim; once the run settles (and the widget disappears) it gains its
 * outcome glyph as the scrollback record. The tool's content string stays
 * model-facing (it carries the continuation instruction).
 */
export function formatResultPreview(
  result: { details: WorkflowToolDetails; text: string },
  expanded: boolean,
  color: ToolColorize = plain,
): string {
  const { runId, status, error } = result.details;
  const id = shortId(runId);
  if (status === "running") {
    return `\n${color("dim", `running in background · /workflow ${id}`)}`;
  }
  if (status === "completed") {
    const presentation = STATUS_STYLES.completed;
    const head = `\n${color(presentation.color, presentation.icon)} completed ${color("dim", `· /workflow ${id} result`)}`;
    return expanded ? `${head}\n${result.text}` : head;
  }
  const presentation = STATUS_STYLES[status];
  const head = `\n${color(presentation.color, presentation.icon)} ${status}${error ? ` ${color("dim", `— ${oneLine(error, 120)}`)}` : ""} ${color("dim", `· /workflow ${id}`)}`;
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
    const value = truncateModelResult(
      valueText(outcome.value) ?? "",
      `/workflow ${shortId(runId)} result`,
    );
    lines.push("<value>", value, "</value>");
  } else {
    lines.push("<error>", outcome.error ?? "unknown error", "</error>");
  }
  lines.push("</workflow-run>");
  return lines.join("\n");
}

export function createWorkflowTool(
  deps: TriggerDeps,
): ToolDefinition<
  typeof WorkflowToolParams,
  WorkflowToolDetails,
  WorkflowToolRenderState
> {
  return {
    name: "workflow",
    label: "Workflow",
    description: `Run a multi-agent workflow of delegated pi agents.

${USE_GATE}

Once requested: pass EITHER "name" (+ "params") to run a saved workflow, OR "flow" for an inline expression. ${FLOW_REFERENCE}`,
    promptSnippet:
      "workflow: run a workflow of delegated agents — only when the user explicitly asks for a workflow or for delegation, never on your own initiative",
    promptGuidelines: [
      'Do not call `workflow` unless the user affirmatively asked to run one — "run the X workflow", "delegate this", "spawn agents", "do these in parallel", or a saved workflow they asked for by name or by its <trigger> situation. Merely mentioning "workflow"/"flow", or asking about a saved workflow, is not a request. Otherwise do the task yourself.',
      "Size, step count, parallelizability, and review/refactor/audit/research shape are not triggers. When a workflow looks like a good fit but was not requested, do the work directly and offer it in one sentence instead of calling the tool.",
      "`workflow` only starts new runs. For a run that already exists, use `steer` for a live agent, or point the user at /workflow <run-id> to inspect or stop it.",
      "Once a workflow is requested: prefer a saved workflow via workflow({name, params}) when one in <workflows> matches; otherwise compose an inline flow — a bare agent leaf for one isolated task, or sequence/parallel/map/loop/while for multi-agent work.",
      "Route deterministically with `switch` instead of asking an agent to decide: predicates over a JSON binding pick exactly one arm; use a `value` arm to yield data without spawning an agent.",
      "Omit the agent name for one-off delegation; it is only needed to select a reusable profile from <agents>. Never invent agent names or create agent-definition files merely to execute an ad-hoc flow — an anonymous node can select skills, tools, model, and thinking directly.",
      "Request a skill by name on the node that needs it. An unknown skill fails the run before anything spawns, so do not guess names; take them from <available_skills>.",
      'In flows, thread data explicitly: bind sequence steps with "as" and reference {name}/{previous} in later tasks; use output:"json" when downstream steps need structured access.',
    ],
    parameters: WorkflowToolParams,
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
        "workflow";
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
      const details: WorkflowToolDetails =
        live && live.status !== "running"
          ? {
              ...result.details,
              status: live.status,
              error: live.error ?? result.details.error,
            }
          : result.details;
      return new Text(
        formatResultPreview({ details, text }, options.expanded, color),
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
              text: `Started workflow run ${id}${label ? ` (${label})` : ""} in the background. End your turn now — do not wait for it. When the run finishes you will be re-invoked with its result to continue; the user can inspect it with /workflow ${id}.`,
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
