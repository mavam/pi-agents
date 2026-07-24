/**
 * Flow validation: structural parsing with node-path error messages,
 * workflow-reference inlining with cycle detection, and static checking of
 * every template reference against the binding scope rules.
 *
 * Scope rules:
 * - `as` is legal only on direct steps of a `sequence`; the binding is visible to
 *   strictly later steps of the same sequence, arbitrarily deep inside them.
 *   Duplicates and shadowing are errors.
 * - `{previous}` resolves against the nearest enclosing sequence; use in a first
 *   step (or with no enclosing sequence) is an error.
 * - `{item}`/`{index}` exist only inside a map body; `{iteration}`/`{last}`
 *   only inside a loop body; `{branches}`/`{items}` only in reduce tasks.
 * - Workflow references are opaque: inside the inlined body only `{params.*}`
 *   and its own bindings resolve.
 */

import {
  type AgentNode,
  BRANCH_KEY_RE,
  bodyPath,
  branchPath,
  casePath,
  elsePath,
  type FlowNode,
  IDENTIFIER_RE,
  type LoopNode,
  type MapNode,
  type ParallelNode,
  type Predicate,
  RESERVED_ROOTS,
  type Reduce,
  reducePath,
  type SequenceNode,
  type SwitchCase,
  type SwitchNode,
  stepPath,
  type ValueNode,
  type WorkflowLike,
  type WorkflowParamDef,
  type WorkflowRefNode,
} from "./ast.js";
import { isSingleReference, templateRefs } from "./interpolate.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class FlowValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(formatIssues(issues));
    this.name = "FlowValidationError";
    this.issues = issues;
  }
}

export function formatIssues(issues: ValidationIssue[]): string {
  const lines = issues.map((issue) => `  at ${issue.path}: ${issue.message}`);
  return `invalid flow:\n${lines.join("\n")}`;
}

export type WorkflowResolver = (name: string) => WorkflowLike | undefined;

export interface ValidateFlowOptions {
  /** Resolves workflow references for inlining. Refs are errors without it. */
  resolveWorkflow?: WorkflowResolver;
  /** Params declared for this flow (when validating a saved workflow's own flow). */
  params?: WorkflowParamDef[];
  /** Name of the workflow being validated, for cycle detection through self-references. */
  selfName?: string;
}

/**
 * Parse, inline, and scope-check a raw flow. Returns the expanded tree
 * (every workflow ref has `body` filled). Throws FlowValidationError with
 * all collected issues.
 */
export function validateFlow(
  raw: unknown,
  options: ValidateFlowOptions = {},
): FlowNode {
  const issues: ValidationIssue[] = [];
  const node = parseFlowNode(raw, "$", issues);
  if (!node || issues.length > 0) throw new FlowValidationError(issues);
  expandNode(
    node,
    "$",
    options.selfName ? [options.selfName] : [],
    options.resolveWorkflow,
    issues,
  );
  if (issues.length > 0) throw new FlowValidationError(issues);
  checkNode(node, "$", initialScope(options.params), issues, false);
  if (issues.length > 0) throw new FlowValidationError(issues);
  return node;
}

// ---------------------------------------------------------------------------
// Structural parsing

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

type Issues = ValidationIssue[];

function asRecord(
  raw: unknown,
  path: string,
  what: string,
  issues: Issues,
): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      path,
      message: `expected ${what}, got ${describeType(raw)}`,
    });
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function checkKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: Issues,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({
        path,
        message: `unknown key '${key}' (allowed: ${allowed.join(", ")})`,
      });
    }
  }
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({
      path,
      message: `'${key}' must be a string, got ${describeType(value)}`,
    });
    return undefined;
  }
  return value;
}

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: `'${key}' must be a non-empty string` });
    return "";
  }
  return value;
}

function optionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      path,
      message: `'${key}' must be a non-empty string when present`,
    });
    return undefined;
  }
  return value;
}

function optionalPositiveInt(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push({ path, message: `'${key}' must be an integer >= 1` });
    return undefined;
  }
  return value;
}

function optionalEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
  issues: Issues,
): T | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    issues.push({
      path,
      message: `'${key}' must be one of: ${values.join(", ")}`,
    });
    return undefined;
  }
  return value as T;
}

function parseBase(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): { as?: string; label?: string } {
  const label = optionalString(obj, "label", path, issues);
  const as = optionalString(obj, "as", path, issues);
  if (as !== undefined) {
    if (!IDENTIFIER_RE.test(as)) {
      issues.push({
        path,
        message: `'as' must match ${IDENTIFIER_RE} (got '${as}')`,
      });
    } else if (RESERVED_ROOTS.has(as)) {
      issues.push({
        path,
        message: `'as' may not use the reserved name '${as}'`,
      });
    }
  }
  return { as, label };
}

const NODE_KINDS = [
  "agent",
  "sequence",
  "parallel",
  "map",
  "loop",
  "switch",
  "value",
  "workflow",
] as const;

/** Parse a raw value into a flow node, collecting issues instead of throwing. */
export function parseFlowNode(
  raw: unknown,
  path: string,
  issues: Issues,
): FlowNode | undefined {
  const obj = asRecord(raw, path, "a flow node object", issues);
  if (!obj) return undefined;
  const kind = obj.kind;
  if (kind === undefined) {
    issues.push({
      path,
      message: `missing 'kind' (one of: ${NODE_KINDS.join(", ")})`,
    });
    return undefined;
  }
  switch (kind) {
    case "agent":
      return parseAgent(obj, path, issues);
    case "sequence":
      return parseSequence(obj, path, issues);
    case "parallel":
      return parseParallel(obj, path, issues);
    case "map":
      return parseMap(obj, path, issues);
    case "loop":
      return parseLoop(obj, path, issues);
    case "switch":
      return parseSwitch(obj, path, issues);
    case "value":
      return parseValue(obj, path, issues);
    case "workflow":
      return parseWorkflowRef(obj, path, issues);
    default:
      issues.push({
        path,
        message: `unknown kind '${String(kind)}' (one of: ${NODE_KINDS.join(", ")})`,
      });
      return undefined;
  }
}

function parseAgent(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): AgentNode {
  checkKeys(
    obj,
    [
      "kind",
      "name",
      "task",
      "output",
      "model",
      "thinking",
      "cwd",
      "scope",
      "as",
      "label",
    ],
    path,
    issues,
  );
  return {
    kind: "agent",
    ...parseBase(obj, path, issues),
    name: optionalNonEmptyString(obj, "name", path, issues),
    task: requiredString(obj, "task", path, issues),
    output: optionalEnum(
      obj,
      "output",
      ["text", "json"] as const,
      path,
      issues,
    ),
    model: optionalString(obj, "model", path, issues),
    thinking: optionalString(obj, "thinking", path, issues),
    cwd: optionalString(obj, "cwd", path, issues),
    scope: optionalEnum(
      obj,
      "scope",
      ["user", "project", "both"] as const,
      path,
      issues,
    ),
  };
}

function parseSequence(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): SequenceNode {
  checkKeys(obj, ["kind", "steps", "as", "label"], path, issues);
  const steps: FlowNode[] = [];
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    issues.push({
      path,
      message: "'steps' must be a non-empty array of flow nodes",
    });
  } else {
    obj.steps.forEach((step, index) => {
      const parsed = parseFlowNode(step, stepPath(path, index), issues);
      if (parsed) steps.push(parsed);
    });
  }
  return { kind: "sequence", ...parseBase(obj, path, issues), steps };
}

function parseReduce(
  raw: unknown,
  path: string,
  issues: Issues,
): Reduce | undefined {
  const obj = asRecord(raw, path, "a reduce spec", issues);
  if (!obj) return undefined;
  checkKeys(obj, ["agent", "task", "output"], path, issues);
  return {
    agent: optionalNonEmptyString(obj, "agent", path, issues),
    task: requiredString(obj, "task", path, issues),
    output: optionalEnum(
      obj,
      "output",
      ["text", "json"] as const,
      path,
      issues,
    ),
  };
}

function parseParallel(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): ParallelNode {
  checkKeys(
    obj,
    [
      "kind",
      "branches",
      "mode",
      "onError",
      "concurrency",
      "reduce",
      "as",
      "label",
    ],
    path,
    issues,
  );
  const branches: Record<string, FlowNode> = {};
  const rawBranches = asRecord(
    obj.branches,
    path,
    "'branches' to be an object of flow nodes",
    issues,
  );
  if (rawBranches) {
    const keys = Object.keys(rawBranches);
    if (keys.length === 0) {
      issues.push({
        path,
        message: "'branches' must have at least one branch",
      });
    }
    for (const key of keys) {
      if (!BRANCH_KEY_RE.test(key)) {
        issues.push({
          path,
          message: `branch key '${key}' must match ${BRANCH_KEY_RE}`,
        });
        continue;
      }
      const parsed = parseFlowNode(
        rawBranches[key],
        branchPath(path, key),
        issues,
      );
      if (parsed) branches[key] = parsed;
    }
  }
  let mode: ParallelNode["mode"];
  if (obj.mode !== undefined) {
    if (obj.mode === "all" || obj.mode === "any") {
      mode = obj.mode;
    } else if (
      typeof obj.mode === "object" &&
      obj.mode !== null &&
      "quorum" in obj.mode
    ) {
      const quorum = (obj.mode as Record<string, unknown>).quorum;
      if (
        typeof quorum !== "number" ||
        !Number.isInteger(quorum) ||
        quorum < 1
      ) {
        issues.push({ path, message: "'mode.quorum' must be an integer >= 1" });
      } else if (quorum > Object.keys(branches).length) {
        issues.push({
          path,
          message: `'mode.quorum' (${quorum}) exceeds the number of branches (${Object.keys(branches).length})`,
        });
      } else {
        mode = { quorum };
      }
    } else {
      issues.push({
        path,
        message: `'mode' must be "all", "any", or {quorum: n}`,
      });
    }
  }
  return {
    kind: "parallel",
    ...parseBase(obj, path, issues),
    branches,
    mode,
    onError: optionalEnum(
      obj,
      "onError",
      ["fail", "collect"] as const,
      path,
      issues,
    ),
    concurrency: optionalPositiveInt(obj, "concurrency", path, issues),
    reduce:
      obj.reduce === undefined
        ? undefined
        : parseReduce(obj.reduce, reducePath(path), issues),
  };
}

function parseMap(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): MapNode {
  checkKeys(
    obj,
    ["kind", "over", "body", "concurrency", "reduce", "as", "label"],
    path,
    issues,
  );
  const over = requiredString(obj, "over", path, issues);
  if (over && !isSingleReference(over)) {
    issues.push({
      path,
      message: `'over' must be exactly one reference like "{files}" or "{scout.files}" (got '${over}')`,
    });
  }
  const body = parseFlowNode(obj.body, bodyPath(path), issues);
  return {
    kind: "map",
    ...parseBase(obj, path, issues),
    over,
    body: body ?? { kind: "sequence", steps: [] },
    concurrency: optionalPositiveInt(obj, "concurrency", path, issues),
    reduce:
      obj.reduce === undefined
        ? undefined
        : parseReduce(obj.reduce, reducePath(path), issues),
  };
}

function parseLoop(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): LoopNode {
  checkKeys(obj, ["kind", "body", "max", "until", "as", "label"], path, issues);
  const body = parseFlowNode(obj.body, bodyPath(path), issues);
  const max = optionalPositiveInt(obj, "max", path, issues);
  if (obj.max === undefined) {
    issues.push({ path, message: "'max' is required (an integer >= 1)" });
  }
  return {
    kind: "loop",
    ...parseBase(obj, path, issues),
    body: body ?? { kind: "sequence", steps: [] },
    max: max ?? 1,
    until:
      obj.until === undefined
        ? undefined
        : parsePredicate(obj.until, `${path}.until`, issues),
  };
}

function parseSwitch(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): SwitchNode {
  checkKeys(obj, ["kind", "on", "cases", "else", "as", "label"], path, issues);
  const on = requiredString(obj, "on", path, issues);
  if (on && !isSingleReference(on)) {
    issues.push({
      path,
      message: `'on' must be exactly one reference like "{gate}" or "{pr.state}" (got '${on}')`,
    });
  }
  const cases: SwitchCase[] = [];
  if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
    issues.push({
      path,
      message: "'cases' must be a non-empty array of {when, then} arms",
    });
  } else {
    obj.cases.forEach((raw, index) => {
      const armPath = `${path}.cases[${index}]`;
      const arm = asRecord(raw, armPath, "a {when, then} arm", issues);
      if (!arm) return;
      checkKeys(arm, ["when", "then"], armPath, issues);
      const when = parsePredicate(arm.when, `${armPath}.when`, issues);
      const then = parseFlowNode(arm.then, casePath(path, index), issues);
      if (when && then) cases.push({ when, then });
    });
  }
  if (obj.else === undefined) {
    issues.push({
      path,
      message: "'else' is required (a switch must be total)",
    });
  }
  const elseNode =
    obj.else === undefined
      ? undefined
      : parseFlowNode(obj.else, elsePath(path), issues);
  return {
    kind: "switch",
    ...parseBase(obj, path, issues),
    on,
    cases,
    else: elseNode ?? { kind: "sequence", steps: [] },
  };
}

/**
 * Reject anything JSON cannot carry: non-finite numbers (YAML `.nan`/`.inf`
 * parse to NaN/Infinity and would silently persist as null) and non-plain
 * objects like Date or Map from programmatic callers.
 */
function checkJsonValue(value: unknown, path: string, issues: Issues): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        issues.push({
          path,
          message: `'value' must be JSON (got non-finite number ${value})`,
        });
      }
      return;
    case "object": {
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((element, index) => {
          checkJsonValue(element, `${path}[${index}]`, issues);
        });
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        issues.push({
          path,
          message: `'value' must be JSON (got ${value.constructor?.name ?? "exotic object"})`,
        });
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        checkJsonValue(child, `${path}.${key}`, issues);
      }
      return;
    }
    default:
      issues.push({
        path,
        message: `'value' must be JSON (got ${typeof value})`,
      });
  }
}

function parseValue(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): ValueNode {
  checkKeys(obj, ["kind", "value", "as", "label"], path, issues);
  if ("value" in obj) {
    checkJsonValue(obj.value, `${path}.value`, issues);
  } else {
    issues.push({ path, message: "'value' is required (any JSON value)" });
  }
  return { kind: "value", ...parseBase(obj, path, issues), value: obj.value };
}

function parseWorkflowRef(
  obj: Record<string, unknown>,
  path: string,
  issues: Issues,
): WorkflowRefNode {
  for (const derived of ["body", "paramDefs"]) {
    if (obj[derived] !== undefined) {
      issues.push({
        path,
        message: `'${derived}' is derived during expansion and cannot be author-supplied`,
      });
    }
  }
  checkKeys(
    obj,
    ["kind", "name", "params", "body", "paramDefs", "as", "label"],
    path,
    issues,
  );
  let params: Record<string, string> | undefined;
  if (obj.params !== undefined) {
    const rawParams = asRecord(
      obj.params,
      path,
      "'params' to be an object of template strings",
      issues,
    );
    if (rawParams) {
      params = {};
      for (const [key, value] of Object.entries(rawParams)) {
        if (typeof value !== "string") {
          issues.push({
            path,
            message: `param '${key}' must be a string, got ${describeType(value)}`,
          });
          continue;
        }
        params[key] = value;
      }
    }
  }
  return {
    kind: "workflow",
    ...parseBase(obj, path, issues),
    name: requiredString(obj, "name", path, issues),
    params,
  };
}

const PREDICATE_KINDS = [
  "eq",
  "ne",
  "gt",
  "lt",
  "exists",
  "empty",
  "and",
  "or",
  "not",
] as const;

const PREDICATE_PATH_RE = /^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export function parsePredicate(
  raw: unknown,
  path: string,
  issues: Issues,
): Predicate | undefined {
  const obj = asRecord(raw, path, "a predicate object", issues);
  if (!obj) return undefined;
  const keys = Object.keys(obj);
  if (
    keys.length !== 1 ||
    !PREDICATE_KINDS.includes(keys[0] as (typeof PREDICATE_KINDS)[number])
  ) {
    issues.push({
      path,
      message: `a predicate must have exactly one of: ${PREDICATE_KINDS.join(", ")}`,
    });
    return undefined;
  }
  const kind = keys[0] as (typeof PREDICATE_KINDS)[number];
  const value = obj[kind];
  const checkPath = (candidate: unknown): candidate is string => {
    if (typeof candidate !== "string" || !PREDICATE_PATH_RE.test(candidate)) {
      issues.push({
        path,
        message: `'${kind}' path must be a dot-path like "done" or "review.findings"`,
      });
      return false;
    }
    return true;
  };
  switch (kind) {
    case "eq":
    case "ne": {
      if (!Array.isArray(value) || value.length !== 2 || !checkPath(value[0])) {
        if (!Array.isArray(value) || value.length !== 2) {
          issues.push({
            path,
            message: `'${kind}' must be a [path, value] pair`,
          });
        }
        return undefined;
      }
      const expected = value[1];
      if (
        expected !== null &&
        typeof expected !== "string" &&
        typeof expected !== "number" &&
        typeof expected !== "boolean"
      ) {
        issues.push({
          path,
          message: `'${kind}' value must be a string, number, boolean, or null`,
        });
        return undefined;
      }
      return kind === "eq"
        ? { eq: [value[0], expected] }
        : { ne: [value[0], expected] };
    }
    case "gt":
    case "lt": {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !checkPath(value[0]) ||
        typeof value[1] !== "number"
      ) {
        issues.push({
          path,
          message: `'${kind}' must be a [path, number] pair`,
        });
        return undefined;
      }
      return kind === "gt"
        ? { gt: [value[0], value[1]] }
        : { lt: [value[0], value[1]] };
    }
    case "exists":
    case "empty": {
      if (!checkPath(value)) return undefined;
      return kind === "exists" ? { exists: value } : { empty: value };
    }
    case "and":
    case "or": {
      if (!Array.isArray(value) || value.length === 0) {
        issues.push({
          path,
          message: `'${kind}' must be a non-empty array of predicates`,
        });
        return undefined;
      }
      const children = value
        .map((child, index) =>
          parsePredicate(child, `${path}.${kind}[${index}]`, issues),
        )
        .filter((child): child is Predicate => child !== undefined);
      if (children.length !== value.length) return undefined;
      return kind === "and" ? { and: children } : { or: children };
    }
    case "not": {
      const child = parsePredicate(value, `${path}.not`, issues);
      return child ? { not: child } : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow-reference expansion (inlining)

function expandNode(
  node: FlowNode,
  path: string,
  stack: string[],
  resolve: WorkflowResolver | undefined,
  issues: Issues,
): void {
  switch (node.kind) {
    case "agent":
    case "value":
      return;
    case "sequence":
      node.steps.forEach((step, index) => {
        expandNode(step, stepPath(path, index), stack, resolve, issues);
      });
      return;
    case "parallel":
      for (const [key, branch] of Object.entries(node.branches)) {
        expandNode(branch, branchPath(path, key), stack, resolve, issues);
      }
      return;
    case "map":
    case "loop":
      expandNode(node.body, bodyPath(path), stack, resolve, issues);
      return;
    case "switch":
      node.cases.forEach((arm, index) => {
        expandNode(arm.then, casePath(path, index), stack, resolve, issues);
      });
      expandNode(node.else, elsePath(path), stack, resolve, issues);
      return;
    case "workflow": {
      if (!resolve) {
        issues.push({
          path,
          message:
            "workflow references are not available in this context (no saved-workflow resolver)",
        });
        return;
      }
      const def = resolve(node.name);
      if (!def) {
        issues.push({ path, message: `unknown workflow '${node.name}'` });
        return;
      }
      if (stack.includes(def.name)) {
        issues.push({
          path,
          message: `workflow cycle: ${[...stack, def.name].join(" → ")}`,
        });
        return;
      }
      const declared = new Set(def.params.map((param) => param.name));
      for (const key of Object.keys(node.params ?? {})) {
        if (!declared.has(key)) {
          issues.push({
            path,
            message: `workflow '${def.name}' has no parameter '${key}'${
              declared.size > 0
                ? ` (declared: ${[...declared].join(", ")})`
                : ""
            }`,
          });
        }
      }
      for (const param of def.params) {
        if (
          param.required &&
          param.default === undefined &&
          node.params?.[param.name] === undefined
        ) {
          issues.push({
            path,
            message: `workflow '${def.name}' requires parameter '${param.name}'`,
          });
        }
      }
      node.paramDefs = def.params;
      node.body = structuredClone(def.flow);
      expandNode(
        node.body,
        bodyPath(path),
        [...stack, def.name],
        resolve,
        issues,
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Binding scope checking

interface ScopeState {
  visible: ReadonlySet<string>;
  params: ReadonlySet<string>;
  hasPrevious: boolean;
  inMap: boolean;
  inLoop: boolean;
}

function initialScope(params?: WorkflowParamDef[]): ScopeState {
  return {
    visible: new Set(),
    params: new Set((params ?? []).map((param) => param.name)),
    hasPrevious: false,
    inMap: false,
    inLoop: false,
  };
}

function checkTemplate(
  template: string,
  path: string,
  scope: ScopeState,
  reduceRoot: "branches" | "items" | undefined,
  issues: Issues,
): void {
  for (const ref of templateRefs(template)) {
    switch (ref.root) {
      case "previous":
        if (!scope.hasPrevious) {
          issues.push({
            path,
            message: `{previous} is not available here (no preceding step in the nearest enclosing sequence)`,
          });
        }
        break;
      case "item":
      case "index":
        if (!scope.inMap) {
          issues.push({
            path,
            message: `{${ref.root}} is only available inside a map body`,
          });
        }
        break;
      case "iteration":
      case "last":
        if (!scope.inLoop) {
          issues.push({
            path,
            message: `{${ref.root}} is only available inside a loop body`,
          });
        }
        break;
      case "params":
        if (ref.path.length === 0) {
          issues.push({
            path,
            message: "{params} must name a parameter, e.g. {params.target}",
          });
        } else if (!scope.params.has(ref.path[0] as string)) {
          issues.push({
            path,
            message: `unknown parameter {params.${ref.path[0]}}${
              scope.params.size > 0
                ? ` (declared: ${[...scope.params].join(", ")})`
                : " (no parameters declared)"
            }`,
          });
        }
        break;
      case "branches":
      case "items":
        if (ref.root !== reduceRoot) {
          issues.push({
            path,
            message: `{${ref.root}} is only available in a ${ref.root === "branches" ? "parallel" : "map"} reduce task`,
          });
        }
        break;
      default:
        if (!scope.visible.has(ref.root)) {
          issues.push({
            path,
            message: `unknown reference ${ref.raw}${
              scope.visible.size > 0
                ? ` (bindings in scope: ${[...scope.visible].join(", ")})`
                : ""
            }`,
          });
        }
    }
  }
}

/** Deep-walk a value node's JSON, checking every string as a template. */
function checkValueTemplates(
  value: unknown,
  path: string,
  scope: ScopeState,
  issues: Issues,
): void {
  if (typeof value === "string") {
    checkTemplate(value, path, scope, undefined, issues);
  } else if (Array.isArray(value)) {
    value.forEach((element, index) => {
      checkValueTemplates(element, `${path}[${index}]`, scope, issues);
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      checkValueTemplates(child, `${path}.${key}`, scope, issues);
    }
  }
}

function checkNode(
  node: FlowNode,
  path: string,
  scope: ScopeState,
  issues: Issues,
  isSeqStep: boolean,
): void {
  if (!isSeqStep && node.as !== undefined) {
    issues.push({
      path,
      message: "'as' is only legal on direct steps of a sequence",
    });
  }
  switch (node.kind) {
    case "agent":
      checkTemplate(node.task, `${path}.task`, scope, undefined, issues);
      return;
    case "sequence": {
      const local = new Set<string>();
      node.steps.forEach((step, index) => {
        const childScope: ScopeState = {
          ...scope,
          visible: new Set([...scope.visible, ...local]),
          hasPrevious: index > 0,
        };
        checkNode(step, stepPath(path, index), childScope, issues, true);
        if (step.as !== undefined) {
          if (local.has(step.as)) {
            issues.push({
              path: stepPath(path, index),
              message: `duplicate binding '${step.as}' in this sequence`,
            });
          } else if (scope.visible.has(step.as)) {
            issues.push({
              path: stepPath(path, index),
              message: `binding '${step.as}' shadows an outer binding`,
            });
          } else {
            local.add(step.as);
          }
        }
      });
      return;
    }
    case "parallel": {
      for (const [key, branch] of Object.entries(node.branches)) {
        checkNode(branch, branchPath(path, key), scope, issues, false);
      }
      if (node.reduce) {
        checkTemplate(
          node.reduce.task,
          `${reducePath(path)}.task`,
          scope,
          "branches",
          issues,
        );
      }
      return;
    }
    case "map": {
      checkTemplate(node.over, `${path}.over`, scope, undefined, issues);
      checkNode(
        node.body,
        bodyPath(path),
        { ...scope, inMap: true },
        issues,
        false,
      );
      if (node.reduce) {
        checkTemplate(
          node.reduce.task,
          `${reducePath(path)}.task`,
          scope,
          "items",
          issues,
        );
      }
      return;
    }
    case "loop":
      checkNode(
        node.body,
        bodyPath(path),
        { ...scope, inLoop: true },
        issues,
        false,
      );
      return;
    case "switch": {
      checkTemplate(node.on, `${path}.on`, scope, undefined, issues);
      node.cases.forEach((arm, index) => {
        checkNode(arm.then, casePath(path, index), scope, issues, false);
      });
      checkNode(node.else, elsePath(path), scope, issues, false);
      return;
    }
    case "value":
      checkValueTemplates(node.value, `${path}.value`, scope, issues);
      return;
    case "workflow": {
      for (const [key, value] of Object.entries(node.params ?? {})) {
        checkTemplate(value, `${path}.params.${key}`, scope, undefined, issues);
      }
      if (node.body) {
        const inner: ScopeState = {
          visible: new Set(),
          params: new Set((node.paramDefs ?? []).map((param) => param.name)),
          hasPrevious: false,
          inMap: false,
          inLoop: false,
        };
        checkNode(node.body, bodyPath(path), inner, issues, false);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities over expanded trees

/** One agent an expanded flow can spawn, with its effective discovery overrides. */
export interface AgentRequirement {
  name: string;
  cwd?: string;
  scope?: string;
}

/**
 * All named agents an expanded flow can spawn (reduce agents included), each
 * with the node-level cwd/scope overrides that will apply at spawn time — so
 * preflight resolves every agent exactly the way the runner will. Anonymous
 * (ad-hoc) calls need no resolution and are not collected.
 */
export function collectAgentRequirements(node: FlowNode): AgentRequirement[] {
  const seen = new Set<string>();
  const requirements: AgentRequirement[] = [];
  const add = (requirement: AgentRequirement): void => {
    const key = `${requirement.name}|${requirement.cwd ?? ""}|${requirement.scope ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(requirement);
  };
  const visit = (current: FlowNode): void => {
    switch (current.kind) {
      case "agent":
        if (current.name !== undefined)
          add({ name: current.name, cwd: current.cwd, scope: current.scope });
        return;
      case "sequence":
        for (const step of current.steps) visit(step);
        return;
      case "parallel":
        for (const branch of Object.values(current.branches)) visit(branch);
        if (current.reduce?.agent !== undefined)
          add({ name: current.reduce.agent });
        return;
      case "map":
        visit(current.body);
        if (current.reduce?.agent !== undefined)
          add({ name: current.reduce.agent });
        return;
      case "loop":
        visit(current.body);
        return;
      case "switch":
        for (const arm of current.cases) visit(arm.then);
        visit(current.else);
        return;
      case "value":
        return;
      case "workflow":
        if (current.body) visit(current.body);
        return;
    }
  };
  visit(node);
  return requirements;
}

/** All named agents an expanded flow can spawn (reduce agents included); anonymous calls are skipped. */
export function collectAgentNames(node: FlowNode): Set<string> {
  const names = new Set<string>();
  const visit = (current: FlowNode): void => {
    switch (current.kind) {
      case "agent":
        if (current.name !== undefined) names.add(current.name);
        return;
      case "sequence":
        for (const step of current.steps) visit(step);
        return;
      case "parallel":
        for (const branch of Object.values(current.branches)) visit(branch);
        if (current.reduce?.agent !== undefined)
          names.add(current.reduce.agent);
        return;
      case "map":
        visit(current.body);
        if (current.reduce?.agent !== undefined)
          names.add(current.reduce.agent);
        return;
      case "loop":
        visit(current.body);
        return;
      case "switch":
        for (const arm of current.cases) visit(arm.then);
        visit(current.else);
        return;
      case "value":
        return;
      case "workflow":
        if (current.body) visit(current.body);
        return;
    }
  };
  visit(node);
  return names;
}
