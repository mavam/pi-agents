import type {
  ContinueSpec,
  FlowSpec,
  ForkFlowSpec,
  JoinFlowSpec,
  LoopFlowSpec,
  SequenceFlowSpec,
  SpawnFlowSpec,
  WorkflowParams,
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
    if (!isRecord(spec.reducer)) {
      throw new Error(`${label}.reducer must be an object.`);
    }
    if (spec.reducer.kind === "collect") {
      return;
    }
    if (spec.reducer.kind === "agent") {
      assertString(spec.reducer.agent, `${label}.reducer.agent`);
      assertString(spec.reducer.task, `${label}.reducer.task`);
      if (
        spec.reducer.output !== undefined &&
        spec.reducer.output !== "text" &&
        spec.reducer.output !== "json"
      ) {
        throw new Error(`${label}.reducer.output must be "text" or "json".`);
      }
      return;
    }
    throw new Error(`${label}.reducer.kind must be "collect" or "agent".`);
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

type SpawnDefaults = {
  agent?: string;
  taskTemplate?: string;
  cwd?: string;
  scope?: SpawnFlowSpec["scope"];
  output?: SpawnFlowSpec["output"];
  branchKey?: string;
};

function resolveBranchTask(defaults?: SpawnDefaults): string | undefined {
  if (!defaults) return undefined;
  if (defaults.taskTemplate) {
    return defaults.taskTemplate.replaceAll(
      "{branch}",
      defaults.branchKey ?? "",
    );
  }
  return defaults.branchKey;
}

function normalizeSpawnLike(
  spec: Record<string, unknown>,
  label: string,
  defaults?: SpawnDefaults,
): SpawnFlowSpec {
  const agent = typeof spec.agent === "string" ? spec.agent : defaults?.agent;
  if (!agent || agent.trim() === "") {
    throw new Error(
      `${label}.agent must be a non-empty string or inherit one from the parent fork.`,
    );
  }

  const task =
    typeof spec.task === "string" ? spec.task : resolveBranchTask(defaults);
  if (!task || task.trim() === "") {
    throw new Error(
      `${label}.task must be a non-empty string or inherit one from fork.taskTemplate.`,
    );
  }

  return {
    kind: "spawn",
    id: typeof spec.id === "string" ? spec.id : undefined,
    label: typeof spec.label === "string" ? spec.label : undefined,
    agent,
    task,
    cwd:
      typeof spec.cwd === "string"
        ? spec.cwd
        : (defaults?.cwd as SpawnFlowSpec["cwd"]),
    scope:
      spec.scope !== undefined
        ? (spec.scope as SpawnFlowSpec["scope"])
        : defaults?.scope,
    output:
      spec.output !== undefined
        ? (spec.output as SpawnFlowSpec["output"])
        : defaults?.output,
  };
}

function normalizeFlowInput(
  spec: unknown,
  label: string,
  defaults?: SpawnDefaults,
): FlowSpec {
  if (typeof spec === "string") {
    return normalizeSpawnLike({ agent: spec }, label, defaults);
  }
  if (!isRecord(spec)) {
    throw new Error(`${label} must be an object.`);
  }

  if (spec.kind === undefined) {
    return normalizeSpawnLike(spec, label, defaults);
  }

  switch (spec.kind) {
    case "spawn":
      return normalizeSpawnLike(spec, label, defaults);
    case "sequence": {
      if (!Array.isArray(spec.steps)) {
        throw new Error(`${label}.steps must be an array.`);
      }
      return {
        kind: "sequence",
        id: typeof spec.id === "string" ? spec.id : undefined,
        label: typeof spec.label === "string" ? spec.label : undefined,
        steps: spec.steps.map((step, index) =>
          normalizeFlowInput(step, `${label}.steps[${index}]`),
        ),
      };
    }
    case "fork": {
      if (!isRecord(spec.branches) || Object.keys(spec.branches).length === 0) {
        throw new Error(`${label}.branches must be a non-empty object.`);
      }
      const branchDefaults: SpawnDefaults = {
        agent: typeof spec.agent === "string" ? spec.agent : undefined,
        taskTemplate:
          typeof spec.taskTemplate === "string" ? spec.taskTemplate : undefined,
        cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
        scope:
          spec.scope !== undefined
            ? (spec.scope as SpawnFlowSpec["scope"])
            : undefined,
        output:
          spec.output !== undefined
            ? (spec.output as SpawnFlowSpec["output"])
            : undefined,
      };
      return {
        kind: "fork",
        id: typeof spec.id === "string" ? spec.id : "fork",
        label: typeof spec.label === "string" ? spec.label : undefined,
        concurrency:
          typeof spec.concurrency === "number" ? spec.concurrency : undefined,
        branches: Object.fromEntries(
          Object.entries(spec.branches).map(([branchKey, branchSpec]) => [
            branchKey,
            normalizeFlowInput(branchSpec, `${label}.branches.${branchKey}`, {
              ...branchDefaults,
              branchKey,
            }),
          ]),
        ),
      };
    }
    case "join":
      return {
        kind: "join",
        id: typeof spec.id === "string" ? spec.id : undefined,
        label: typeof spec.label === "string" ? spec.label : undefined,
        from: spec.from as string,
        mode: spec.mode as JoinFlowSpec["mode"],
        quorum: typeof spec.quorum === "number" ? spec.quorum : undefined,
        reducer: spec.reducer as JoinFlowSpec["reducer"],
        onFailure: spec.onFailure as JoinFlowSpec["onFailure"],
      };
    case "loop":
      return {
        kind: "loop",
        id: typeof spec.id === "string" ? spec.id : "loop",
        label: typeof spec.label === "string" ? spec.label : undefined,
        body: normalizeFlowInput(spec.body, `${label}.body`),
        maxIterations: spec.maxIterations as number,
        continueWhen: spec.continueWhen as ContinueSpec | undefined,
      };
    default:
      throw new Error(
        `${label}.kind must be one of spawn, sequence, fork, join, loop.`,
      );
  }
}

function validateFlowReferences(flow: FlowSpec): void {
  const ids = new Map<string, FlowSpec["kind"]>();
  const joinedForks = new Map<string, string>();

  const collectIds = (spec: FlowSpec, label: string) => {
    if (spec.id) {
      const previous = ids.get(spec.id);
      if (previous) {
        throw new Error(
          `${label}.id duplicates "${spec.id}", which is already used by a ${previous} node.`,
        );
      }
      ids.set(spec.id, spec.kind);
    }

    switch (spec.kind) {
      case "spawn":
      case "join":
        return;
      case "sequence":
        for (const [index, step] of spec.steps.entries()) {
          collectIds(step, `${label}.steps[${index}]`);
        }
        return;
      case "fork":
        for (const [branchKey, branchSpec] of Object.entries(spec.branches)) {
          collectIds(branchSpec, `${label}.branches.${branchKey}`);
        }
        return;
      case "loop":
        collectIds(spec.body, `${label}.body`);
        return;
    }
  };

  const visit = (
    spec: FlowSpec,
    label: string,
    visibleForks: ReadonlySet<string>,
  ) => {
    switch (spec.kind) {
      case "spawn":
        return;
      case "sequence": {
        const localVisibleForks = new Set(visibleForks);
        for (const [index, step] of spec.steps.entries()) {
          visit(step, `${label}.steps[${index}]`, localVisibleForks);
          if (step.kind === "fork") {
            localVisibleForks.add(step.id);
          }
        }
        return;
      }
      case "fork":
        for (const [branchKey, branchSpec] of Object.entries(spec.branches)) {
          visit(branchSpec, `${label}.branches.${branchKey}`, visibleForks);
        }
        return;
      case "join": {
        const targetKind = ids.get(spec.from);
        if (!targetKind) {
          throw new Error(
            `${label}.from references unknown fork "${spec.from}".`,
          );
        }
        if (targetKind !== "fork") {
          throw new Error(
            `${label}.from must reference a fork node, but "${spec.from}" is a ${targetKind}.`,
          );
        }
        if (!visibleForks.has(spec.from)) {
          throw new Error(
            `${label}.from must reference a fork that is already available in this scope. Fork "${spec.from}" is defined later or inside a different scope.`,
          );
        }
        const previousJoin = joinedForks.get(spec.from);
        if (previousJoin) {
          throw new Error(
            `${label}.from references fork "${spec.from}", which is already joined at ${previousJoin}. Each fork can only be joined once.`,
          );
        }
        joinedForks.set(spec.from, `${label}.from`);
        return;
      }
      case "loop":
        visit(spec.body, `${label}.body`, new Set(visibleForks));
        return;
    }
  };

  collectIds(flow, "flow");
  visit(flow, "flow", new Set());
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

export function validateWorkflowParams(
  params: unknown,
): asserts params is WorkflowParams {
  if (!isRecord(params)) {
    throw new Error("workflow parameters must be an object.");
  }
  assertOptionalString(params.label, "label");
  validateFlowSpec(params.flow, "flow");
  validateFlowReferences(params.flow);
  assertOptionalString(params.cwd, "cwd");
  if (
    params.scope !== undefined &&
    params.scope !== "user" &&
    params.scope !== "project" &&
    params.scope !== "both"
  ) {
    throw new Error('scope must be "user", "project", or "both".');
  }
  if (params.budgets !== undefined) {
    if (!isRecord(params.budgets)) {
      throw new Error("budgets must be an object.");
    }
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

export function normalizeWorkflowParams(params: unknown): WorkflowParams {
  if (!isRecord(params)) {
    throw new Error("workflow parameters must be an object.");
  }

  const normalized: WorkflowParams = {
    label: typeof params.label === "string" ? params.label : undefined,
    flow: normalizeFlowInput(params.flow, "flow"),
    cwd: typeof params.cwd === "string" ? params.cwd : undefined,
    scope:
      params.scope !== undefined
        ? (params.scope as WorkflowParams["scope"])
        : undefined,
    budgets: params.budgets as WorkflowParams["budgets"],
  };

  validateWorkflowParams(normalized);
  return normalized;
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Expected JSON output but received empty text.");
  }

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
