/**
 * The launch contract: the one place that turns a raw start request into a
 * validated launch plan.
 *
 * Every entry surface (tool, slash command, event hook, RPC, extension API)
 * reduces to: parse surface input → `prepareLaunch` → format surface output.
 * Triggers must not discover workflows for execution, resolve saved
 * definitions, or validate flows themselves — a drift check in the test
 * suite enforces this.
 *
 * Problems are classified explicitly:
 * - Fatal (thrown): invalid flows, unknown workflows, untrusted project
 *   scopes, malformed requests. These abort before anything starts.
 * - Recoverable (collected in `warnings`): invalid labels or display paths,
 *   parameters that do not apply. The run starts; presentation falls back.
 */

import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import {
  type Budgets,
  effectiveScope,
  type FlowNode,
  type Scope,
} from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { softDisplayPath } from "../ui/display.js";

/** A start request as written by any entry surface. */
export interface LaunchRequest {
  /** Inline flow expression. Exactly one of `flow` and `workflow`. */
  flow?: unknown;
  /** Saved workflow name. Exactly one of `flow` and `workflow`. */
  workflow?: string;
  /** Literal parameters for a saved workflow. */
  params?: Record<string, string>;
  label?: string;
  /** Requested display path; invalid values degrade to a warning. */
  display?: unknown;
  cwd: string;
  /** Requested discovery scope; clamped by project trust. */
  scope?: Scope;
  /** Project trust; when false, project scope is unavailable. */
  trusted: boolean;
  budgets?: Budgets;
}

/** A validated launch plan plus recoverable warnings. */
export interface LaunchPlan {
  flow: FlowNode;
  cwd: string;
  scope: Scope;
  label?: string;
  display?: string;
  budgets?: Budgets;
  /** Saved workflow name when the request named one. */
  workflowName?: string;
  /** Recoverable problems; never block the launch. */
  warnings: string[];
}

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

/**
 * Expand a saved workflow into its validated flow tree, for rendering.
 * Returns undefined when the workflow is unknown or fails validation.
 */
export function expandSavedFlow(
  name: string,
  cwd: string,
  scope: Scope = "both",
): { name: string; flow: FlowNode } | undefined {
  try {
    const { workflows } = discoverWorkflows(cwd, scope);
    const def = resolveWorkflowByName(workflows, name);
    if (!def) return undefined;
    const flow = validateFlow(structuredClone(def.flow) as unknown, {
      resolveWorkflow: (candidate) =>
        resolveWorkflowByName(workflows, candidate),
      selfName: def.name,
      params: def.params,
    });
    return { name: def.name, flow };
  } catch {
    return undefined;
  }
}

/**
 * Validate a launch request into a plan, or throw with actionable errors.
 *
 * Fatal errors are complete at the top level; within a malformed flow node,
 * validation reports the first error at its node path without cascading
 * synthetic child errors.
 */
export function prepareLaunch(request: LaunchRequest): LaunchPlan {
  const warnings: string[] = [];

  const hasFlow = request.flow !== undefined;
  const hasWorkflow = request.workflow !== undefined;
  if (Number(hasFlow) + Number(hasWorkflow) !== 1) {
    throw new Error(
      'pass exactly one of "name" (saved workflow) or "flow" (inline expression)',
    );
  }
  if (hasFlow && request.params !== undefined) {
    warnings.push(
      "Ignored 'params': parameters only apply to a saved workflow.",
    );
  }
  if (!request.trusted && request.scope === "project") {
    throw new Error(
      "scope 'project' is unavailable: this project is not trusted, so project-local agents and workflows cannot run",
    );
  }
  const scope = effectiveScope(request.scope, request.trusted);
  const { workflows } = discoverWorkflows(request.cwd, scope);
  const resolveWorkflow = (name: string) =>
    resolveWorkflowByName(workflows, name);

  const requested = softDisplayPath(request.display);
  if (requested.warning) warnings.push(requested.warning);

  let raw: unknown;
  let label = request.label;
  let display = requested.display;
  let workflowName: string | undefined;
  if (hasWorkflow && request.workflow !== undefined) {
    const def = resolveWorkflow(request.workflow);
    if (!def) {
      const available = workflows.map((wf) => wf.name).join(", ") || "none";
      throw new Error(
        `unknown workflow '${request.workflow}'. Available: ${available}`,
      );
    }
    raw = { kind: "workflow", name: def.name, params: request.params ?? {} };
    workflowName = def.name;
    label = label ?? def.name;
    display = requested.display ?? def.display;
  } else {
    raw = coerceInlineFlow(request.flow);
  }

  const flow = validateFlow(raw, { resolveWorkflow });

  return {
    flow,
    cwd: request.cwd,
    scope,
    label,
    display,
    budgets: request.budgets,
    workflowName,
    warnings,
  };
}
