import type {
  ComposeParams,
  ContinueSpec,
  FlowSpec,
  ForkFlowSpec,
  JoinFlowSpec,
  LoopFlowSpec,
  SequenceFlowSpec,
  SpawnFlowSpec,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined) assertString(value, label);
}

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function validateContinueSpec(
  spec: unknown,
  label: string,
): asserts spec is ContinueSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "result_field") {
    throw new Error(`${label}.kind must be "result_field".`);
  }
  assertString(spec.path, `${label}.path`);
  if (typeof spec.equals !== "boolean") {
    throw new Error(`${label}.equals must be a boolean.`);
  }
}

function validateSpawnSpec(
  spec: unknown,
  label: string,
): asserts spec is SpawnFlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "spawn") throw new Error(`${label}.kind must be "spawn".`);
  assertOptionalString(spec.id, `${label}.id`);
  assertOptionalString(spec.label, `${label}.label`);
  assertString(spec.agent, `${label}.agent`);
  assertString(spec.task, `${label}.task`);
  assertOptionalString(spec.cwd, `${label}.cwd`);
  if (
    spec.scope !== undefined &&
    spec.scope !== "user" &&
    spec.scope !== "project" &&
    spec.scope !== "both"
  ) {
    throw new Error(`${label}.scope must be "user", "project", or "both".`);
  }
  if (
    spec.output !== undefined &&
    spec.output !== "text" &&
    spec.output !== "json"
  ) {
    throw new Error(`${label}.output must be "text" or "json".`);
  }
}

function validateSequenceSpec(
  spec: unknown,
  label: string,
): asserts spec is SequenceFlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "sequence") {
    throw new Error(`${label}.kind must be "sequence".`);
  }
  assertOptionalString(spec.id, `${label}.id`);
  assertOptionalString(spec.label, `${label}.label`);
  if (!Array.isArray(spec.steps)) {
    throw new Error(`${label}.steps must be an array.`);
  }
  for (const [index, step] of spec.steps.entries()) {
    validateFlowSpec(step, `${label}.steps[${index}]`);
  }
}

function validateForkSpec(
  spec: unknown,
  label: string,
): asserts spec is ForkFlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "fork") throw new Error(`${label}.kind must be "fork".`);
  assertString(spec.id, `${label}.id`);
  assertOptionalString(spec.label, `${label}.label`);
  if (!isRecord(spec.branches) || Object.keys(spec.branches).length === 0) {
    throw new Error(`${label}.branches must be a non-empty object.`);
  }
  for (const [branchKey, branchSpec] of Object.entries(spec.branches)) {
    validateFlowSpec(branchSpec, `${label}.branches.${branchKey}`);
  }
  if (spec.concurrency !== undefined) {
    assertPositiveInteger(spec.concurrency, `${label}.concurrency`);
  }
}

function validateJoinSpec(
  spec: unknown,
  label: string,
): asserts spec is JoinFlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "join") throw new Error(`${label}.kind must be "join".`);
  assertOptionalString(spec.id, `${label}.id`);
  assertOptionalString(spec.label, `${label}.label`);
  assertString(spec.from, `${label}.from`);
  if (spec.mode !== "all" && spec.mode !== "any" && spec.mode !== "quorum") {
    throw new Error(`${label}.mode must be "all", "any", or "quorum".`);
  }
  if (spec.quorum !== undefined) {
    assertPositiveInteger(spec.quorum, `${label}.quorum`);
  }
  if (spec.mode === "quorum" && spec.quorum === undefined) {
    throw new Error(`${label}.quorum is required when mode="quorum".`);
  }
  if (
    spec.onFailure !== undefined &&
    spec.onFailure !== "failFast" &&
    spec.onFailure !== "collectErrors"
  ) {
    throw new Error(
      `${label}.onFailure must be "failFast" or "collectErrors".`,
    );
  }
  if (spec.reducer !== undefined) {
    if (!isRecord(spec.reducer))
      throw new Error(`${label}.reducer must be an object.`);
    if (spec.reducer.kind === "collect") {
      // nothing else
    } else if (spec.reducer.kind === "agent") {
      assertString(spec.reducer.agent, `${label}.reducer.agent`);
      assertString(spec.reducer.task, `${label}.reducer.task`);
      if (
        spec.reducer.output !== undefined &&
        spec.reducer.output !== "text" &&
        spec.reducer.output !== "json"
      ) {
        throw new Error(`${label}.reducer.output must be "text" or "json".`);
      }
    } else {
      throw new Error(`${label}.reducer.kind must be "collect" or "agent".`);
    }
  }
}

function validateLoopSpec(
  spec: unknown,
  label: string,
): asserts spec is LoopFlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  if (spec.kind !== "loop") throw new Error(`${label}.kind must be "loop".`);
  assertString(spec.id, `${label}.id`);
  assertOptionalString(spec.label, `${label}.label`);
  validateFlowSpec(spec.body, `${label}.body`);
  assertPositiveInteger(spec.maxIterations, `${label}.maxIterations`);
  if (spec.continueWhen !== undefined) {
    validateContinueSpec(spec.continueWhen, `${label}.continueWhen`);
  }
}

export function validateFlowSpec(
  spec: unknown,
  label = "flow",
): asserts spec is FlowSpec {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  switch (spec.kind) {
    case "spawn":
      validateSpawnSpec(spec, label);
      return;
    case "sequence":
      validateSequenceSpec(spec, label);
      return;
    case "fork":
      validateForkSpec(spec, label);
      return;
    case "join":
      validateJoinSpec(spec, label);
      return;
    case "loop":
      validateLoopSpec(spec, label);
      return;
    default:
      throw new Error(
        `${label}.kind must be one of spawn, sequence, fork, join, loop.`,
      );
  }
}

export function validateComposeParams(
  params: unknown,
): asserts params is ComposeParams {
  if (!isRecord(params))
    throw new Error(`workflow parameters must be an object.`);
  assertOptionalString(params.label, "label");
  validateFlowSpec(params.flow, "flow");
  assertOptionalString(params.cwd, "cwd");
  if (
    params.scope !== undefined &&
    params.scope !== "user" &&
    params.scope !== "project" &&
    params.scope !== "both"
  ) {
    throw new Error(`scope must be "user", "project", or "both".`);
  }
  if (params.budgets !== undefined) {
    if (!isRecord(params.budgets))
      throw new Error(`budgets must be an object.`);
    for (const key of [
      "maxDepth",
      "maxChildren",
      "maxParallelism",
      "maxIterations",
    ] as const) {
      const value = params.budgets[key];
      if (value !== undefined) assertPositiveInteger(value, `budgets.${key}`);
    }
  }
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed)
    throw new Error("Expected JSON output but received empty text.");

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenceMatch) {
      throw new Error("Expected valid JSON output from delegated agent.");
    }
    return JSON.parse(fenceMatch[1] ?? "");
  }
}
