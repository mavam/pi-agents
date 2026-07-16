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
import { type Static, Type } from "typebox";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import type { Budgets, Scope } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import type { RunStatus } from "../run/events.js";
import type { RunOutcome } from "../run/interpreter.js";
import { formatUsage, shortId } from "../ui/render.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

const FLOW_REFERENCE = `A flow is a JSON expression tree; every node yields a value. Node kinds:
- {"kind":"agent","name":"<agent>","task":"...","output":"text"|"json"} — run one delegated agent (leaf). A bare agent node is a valid flow.
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
    const value =
      typeof outcome.value === "string"
        ? outcome.value
        : (JSON.stringify(outcome.value, null, 2) ?? "");
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
      const scope = (params.scope ?? "both") as Scope;
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
