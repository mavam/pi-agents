/**
 * The flow interpreter: evaluates an expanded, validated flow tree against an
 * environment of explicit bindings, emitting run events along the way.
 *
 * Every node yields a JSON value. Data flows only through `as` bindings,
 * `{previous}`, map item frames, iterative frames, and workflow params —
 * nothing is injected implicitly.
 */

import {
  addUsage,
  emptyUsage,
  type SpawnProgress,
  type SpawnUsage,
} from "../engine/types.js";
import {
  type AgentNode,
  type Budgets,
  bodyPath,
  branchPath,
  casePath,
  elsePath,
  type FlowNode,
  type LoopNode,
  type MapNode,
  type ParallelNode,
  type Reduce,
  reducePath,
  type Scope,
  type SequenceNode,
  type SwitchCase,
  type SwitchNode,
  stepPath,
  type ThinkingLevel,
  type WhileNode,
  type WorkflowRefNode,
} from "../model/ast.js";
import {
  isSingleReference,
  type RootResolver,
  renderTemplate,
  resolvePath,
  templateRefs,
} from "../model/interpolate.js";
import type { JsonSchema } from "../model/json-schema.js";
import { evaluatePredicate } from "../model/predicate.js";
import { BudgetActor, BudgetExceededError, Semaphore } from "./budgets.js";
import type { CancelReason, RunEvent, RunSource, RunStatus } from "./events.js";
import { CancelledError, type PoolOutcome, runPool } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Agent runner abstraction (implemented over the spawn engine; faked in tests)

export interface AgentCall {
  /** Profile name; absent spawns an anonymous ad-hoc agent. */
  profile?: string;
  task: string;
  /** Optional JSON Schema for a machine-readable result. Omit for text. */
  resultSchema?: JsonSchema;
  /** Node-level model override (wins over the agent file). */
  model?: string;
  /** Node-level thinking override (wins over the agent file). */
  thinking?: ThinkingLevel;
  /** Node-level skills; replaces the profile's list, `[]` forces none. */
  skills?: string[];
  /** Node-level tool allowlist; replaces the profile's, `[]` means no tools. */
  tools?: string[];
  cwd?: string;
  scope?: Scope;
  path: string;
  instance: string;
  signal: AbortSignal;
  onProgress?: (progress: SpawnProgress) => void;
}

export interface AgentResult {
  value: unknown;
  usage?: SpawnUsage;
  /** Effective model reported by the engine, provider-qualified when possible. */
  model?: string;
}

export interface PlannedNodeModel {
  model?: string;
  requestedModel?: string;
  thinking?: string;
}

export type AgentRunner = (call: AgentCall) => Promise<AgentResult>;

// ---------------------------------------------------------------------------
// Environment

interface Env {
  bindings: ReadonlyMap<string, unknown>;
  params: Readonly<Record<string, unknown>>;
  hasPrevious: boolean;
  previous?: unknown;
  inMap: boolean;
  item?: unknown;
  index?: number;
  iterationFrame?: "loop" | "while";
  iteration?: number;
  last?: unknown;
  current?: unknown;
}

function rootEnv(params: Record<string, unknown>): Env {
  return {
    bindings: new Map(),
    params,
    hasPrevious: false,
    inMap: false,
    iterationFrame: undefined,
  };
}

function envResolver(
  env: Env,
  reduceRoot?: { name: "branches" | "items"; value: unknown },
): RootResolver {
  return (root) => {
    switch (root) {
      case "previous":
        return env.hasPrevious
          ? { found: true, value: env.previous }
          : { found: false };
      case "item":
        return env.inMap ? { found: true, value: env.item } : { found: false };
      case "index":
        return env.inMap ? { found: true, value: env.index } : { found: false };
      case "iteration":
        return env.iterationFrame !== undefined
          ? { found: true, value: env.iteration }
          : { found: false };
      case "last":
        return env.iterationFrame === "loop"
          ? { found: true, value: env.last }
          : { found: false };
      case "current":
        return env.iterationFrame === "while"
          ? { found: true, value: env.current }
          : { found: false };
      case "params":
        return { found: true, value: env.params };
      case "branches":
      case "items":
        return reduceRoot && reduceRoot.name === root
          ? { found: true, value: reduceRoot.value }
          : { found: false };
      default:
        return env.bindings.has(root)
          ? { found: true, value: env.bindings.get(root) }
          : { found: false };
    }
  };
}

/** Resolve a single-reference template (`map.over`, `switch.on`, …) to its value. */
function resolveSingleRef(template: string, env: Env, what: string): unknown {
  const ref = templateRefs(template)[0];
  if (!ref) throw new Error(`${what} is not a reference: '${template}'`);
  const root = envResolver(env)(ref.root);
  if (!root.found) throw new Error(`${what}: unknown reference ${ref.raw}`);
  const resolved =
    ref.path.length === 0 ? root : resolvePath(root.value, ref.path);
  if (!resolved.found) {
    throw new Error(
      `${what}: path '${ref.path.join(".")}' not found in {${ref.root}}`,
    );
  }
  return resolved.value;
}

/** Preserve an exact parameter reference as JSON. An available but undefined
 * frame root (notably `{last}` before loop iteration 0) normalizes to null
 * before dot-path traversal, matching value-node JSON semantics. */
function resolveWorkflowParam(
  template: string,
  env: Env,
  name: string,
): unknown {
  if (!isSingleReference(template)) {
    return renderTemplate(template, envResolver(env));
  }
  const ref = templateRefs(template)[0];
  if (ref) {
    const root = envResolver(env)(ref.root);
    if (root.found && root.value === undefined) return null;
  }
  return resolveSingleRef(template, env, `workflow param '${name}'`) ?? null;
}

/**
 * Deep-interpolate a value node's JSON: a string that is exactly one
 * reference substitutes the referenced value itself (type-preserving); any
 * other string renders as text.
 */
function interpolateValue(value: unknown, env: Env): unknown {
  if (typeof value === "string") {
    // `?? null`: an exact reference can resolve to undefined ({last} on
    // iteration 0), which JSON cannot carry through event persistence.
    return isSingleReference(value)
      ? (resolveSingleRef(value, env, "value") ?? null)
      : renderTemplate(value, envResolver(env));
  }
  if (Array.isArray(value)) {
    return value.map((element) => interpolateValue(element, env));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        interpolateValue(child, env),
      ]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Execution

export interface ExecuteOptions {
  runId: string;
  /** Expanded, validated flow (from validateFlow). */
  flow: FlowNode;
  runAgent: AgentRunner;
  emit?: (event: RunEvent) => void;
  label?: string;
  /** Saved-workflow result path selected for human-facing rendering. */
  display?: string;
  /** Recoverable request problems persisted with the run. */
  warnings?: string[];
  source?: RunSource;
  /** Resolved top-level params (saved workflow invocations). */
  params?: Record<string, unknown>;
  budgets?: Budgets;
  /** Cross-process delegation depth this run starts at. */
  depth?: number;
  signal?: AbortSignal;
  cwd?: string;
  scope?: Scope;
  originSessionFile?: string;
  /** Resolve the planned identity of an agent or reduce before it starts. */
  resolvePlannedModel?: (call: AgentCall) => PlannedNodeModel | undefined;
  /** True while a user is attached to any agent in this run. Run-level
   * budget cancellation waits for the attachment to close. */
  isHeld?: () => boolean;
}

export interface RunOutcome {
  status: Exclude<RunStatus, "running">;
  value?: unknown;
  error?: string;
  usage: SpawnUsage;
  agents: number;
}

export async function executeFlow(
  options: ExecuteOptions,
): Promise<RunOutcome> {
  return await new Interpreter(options).run();
}

function cancelReasonOf(
  error: unknown,
  signal: AbortSignal,
): CancelReason | undefined {
  if (error instanceof CancelledError) return error.reason;
  if (signal.aborted) {
    return signal.reason instanceof CancelledError
      ? signal.reason.reason
      : "stopped";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The budget message carried by a "budget" cancellation, when present. */
function cancelMessageOf(
  error: unknown,
  signal: AbortSignal,
): string | undefined {
  if (error instanceof CancelledError) return error.message;
  if (signal.aborted && signal.reason instanceof CancelledError) {
    return signal.reason.message;
  }
  return undefined;
}

const HELD_BUDGET_RECHECK_MS = 250;

class Interpreter {
  private readonly options: ExecuteOptions;
  private readonly budgets: BudgetActor;
  /** Caps simultaneously running agents globally, across nested pools. */
  private readonly parallelism: Semaphore;
  private readonly usage: SpawnUsage = emptyUsage();
  private readonly depth: number;
  /** The run's controller, for run-level budget aborts. */
  private controller?: AbortController;
  /** Last recorded token/cost snapshot per agent instance, for deltas. */
  private readonly usageSnapshots = new Map<
    string,
    { tokens: number; cost: number }
  >();
  /** Latest effective model emitted per agent instance. */
  private readonly effectiveModels = new Map<string, string>();
  /** A run-level budget breach waits here while an attached user holds any
   * child. Only the first breach determines the eventual failure. */
  private pendingBudgetMessage: string | undefined;
  private heldBudgetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ExecuteOptions) {
    this.options = options;
    this.budgets = new BudgetActor(options.budgets);
    this.parallelism = new Semaphore(this.budgets.limits.maxParallelism);
    this.depth = options.depth ?? 0;
  }

  private emit(event: RunEvent): void {
    this.options.emit?.(event);
  }

  /** Apply a pending run-level breach once no user holds an agent. */
  private checkPendingBudgetAbort(): void {
    const controller = this.controller;
    const message = this.pendingBudgetMessage;
    if (!controller || controller.signal.aborted || message === undefined)
      return;
    if (this.options.isHeld?.()) {
      if (!this.heldBudgetTimer) {
        this.heldBudgetTimer = setTimeout(() => {
          this.heldBudgetTimer = undefined;
          this.checkPendingBudgetAbort();
        }, HELD_BUDGET_RECHECK_MS);
        this.heldBudgetTimer.unref?.();
      }
      return;
    }
    if (this.heldBudgetTimer) clearTimeout(this.heldBudgetTimer);
    this.heldBudgetTimer = undefined;
    controller.abort(new CancelledError("budget", message));
  }

  /** Abort for a run-level budget breach, deferring while a user is attached. */
  private requestBudgetAbort(message: string): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.pendingBudgetMessage ??= message;
    this.checkPendingBudgetAbort();
  }

  async run(): Promise<RunOutcome> {
    const controller = new AbortController();
    this.controller = controller;
    const external = this.options.signal;
    const onExternalAbort = () =>
      controller.abort(new CancelledError("stopped"));
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });

    const maxDuration = this.budgets.limits.maxDuration;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    if (maxDuration !== undefined) {
      durationTimer = setTimeout(
        () =>
          this.requestBudgetAbort(
            `run duration budget exceeded (maxDuration: ${maxDuration}s)`,
          ),
        maxDuration * 1000,
      );
      durationTimer.unref?.();
    }

    this.emit({
      type: "run_created",
      at: Date.now(),
      run: {
        id: this.options.runId,
        label: this.options.label,
        display: this.options.display,
        warnings: this.options.warnings,
        source: this.options.source ?? { kind: "tool" },
        flow: this.options.flow,
        params: this.options.params,
        budgets: this.options.budgets,
        cwd: this.options.cwd,
        scope: this.options.scope,
        originSessionFile: this.options.originSessionFile,
        depth: this.depth,
      },
    });

    let outcome: RunOutcome;
    try {
      const value = await this.evaluate(
        this.options.flow,
        "$",
        "$",
        rootEnv(this.options.params ?? {}),
        controller.signal,
      );
      outcome = {
        status: "completed",
        value,
        usage: { ...this.usage },
        agents: await this.budgets.usedAgents(),
      };
    } catch (error) {
      const cancelled = cancelReasonOf(error, controller.signal);
      // A budget cancellation is a clear terminal failure, not a user stop.
      const budgetError =
        cancelled === "budget"
          ? (cancelMessageOf(error, controller.signal) ?? "budget exceeded")
          : undefined;
      outcome = {
        status: cancelled && !budgetError ? "stopped" : "failed",
        error:
          budgetError ?? (cancelled ? "Run stopped." : errorMessage(error)),
        usage: { ...this.usage },
        agents: await this.budgets.usedAgents(),
      };
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
      if (this.heldBudgetTimer) clearTimeout(this.heldBudgetTimer);
      this.heldBudgetTimer = undefined;
      this.pendingBudgetMessage = undefined;
      this.controller = undefined;
      external?.removeEventListener("abort", onExternalAbort);
    }

    this.emit({
      type: "run_completed",
      at: Date.now(),
      runId: this.options.runId,
      status: outcome.status,
      value: outcome.value,
      error: outcome.error,
      usage: outcome.usage,
      agents: outcome.agents,
    });
    return outcome;
  }

  /** Evaluate a node, wrapping it in started/completed/failed/cancelled events. */
  private async evaluate(
    node: FlowNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw signal.reason instanceof CancelledError
        ? signal.reason
        : new CancelledError("stopped");
    }
    const planned =
      node.kind === "agent"
        ? this.options.resolvePlannedModel?.({
            profile: node.profile,
            task: node.task,
            resultSchema: node.json,
            model: node.model,
            thinking: node.thinking,
            skills: node.skills,
            tools: node.tools,
            cwd: node.cwd ?? this.options.cwd,
            scope: node.scope ?? this.options.scope,
            path,
            instance,
            signal,
          })
        : undefined;
    this.emit({
      type: "node_started",
      at: Date.now(),
      runId: this.options.runId,
      path,
      instance,
      kind: node.kind,
      profile: node.kind === "agent" ? node.profile : undefined,
      label: node.label,
      model: planned?.model,
      requestedModel: planned?.requestedModel,
      thinking: planned?.thinking,
    });
    try {
      const result = await this.evaluateInner(
        node,
        path,
        instance,
        env,
        signal,
      );
      this.emit({
        type: "node_completed",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        value: result.value,
        usage: result.usage,
      });
      return result.value;
    } catch (error) {
      const cancelled = cancelReasonOf(error, signal);
      if (cancelled) {
        this.emit({
          type: "node_cancelled",
          at: Date.now(),
          runId: this.options.runId,
          path,
          instance,
          reason: cancelled,
        });
        throw error instanceof CancelledError
          ? error
          : new CancelledError(cancelled);
      }
      this.emit({
        type: "node_failed",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        error: errorMessage(error),
        partialText:
          error instanceof BudgetExceededError ? error.partialText : undefined,
      });
      throw error;
    }
  }

  private async evaluateInner(
    node: FlowNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<{ value: unknown; usage?: SpawnUsage }> {
    switch (node.kind) {
      case "agent":
        return await this.evaluateAgent(node, path, instance, env, signal);
      case "sequence":
        return {
          value: await this.evaluateSequence(node, path, instance, env, signal),
        };
      case "parallel":
        return {
          value: await this.evaluateParallel(node, path, instance, env, signal),
        };
      case "map":
        return {
          value: await this.evaluateMap(node, path, instance, env, signal),
        };
      case "loop":
        return {
          value: await this.evaluateLoop(node, path, instance, env, signal),
        };
      case "while":
        return {
          value: await this.evaluateWhile(node, path, instance, env, signal),
        };
      case "switch":
        return {
          value: await this.evaluateSwitch(node, path, instance, env, signal),
        };
      case "value":
        return { value: interpolateValue(node.value, env) };
      case "workflow":
        return {
          value: await this.evaluateWorkflow(node, path, instance, env, signal),
        };
    }
  }

  /**
   * Fold an agent's cumulative usage snapshot into the run-level token/cost
   * budgets. Breaches abort the whole run — cancelling every node — instead
   * of failing one agent, because these budgets are run-scoped.
   */
  private async recordUsageSnapshot(
    instance: string,
    usage: SpawnUsage,
  ): Promise<void> {
    const previous = this.usageSnapshots.get(instance) ?? {
      tokens: 0,
      cost: 0,
    };
    const snapshot = { tokens: usage.input + usage.output, cost: usage.cost };
    const delta = {
      tokens: snapshot.tokens - previous.tokens,
      cost: snapshot.cost - previous.cost,
    };
    this.usageSnapshots.set(instance, snapshot);
    if (delta.tokens === 0 && delta.cost === 0) return;
    try {
      await this.budgets.recordUsage(delta);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      this.requestBudgetAbort(error.message);
    }
  }

  private recordEffectiveModel(
    path: string,
    instance: string,
    model: string | undefined,
  ): void {
    if (model === undefined || this.effectiveModels.get(instance) === model)
      return;
    this.effectiveModels.set(instance, model);
    this.emit({
      type: "node_model",
      at: Date.now(),
      runId: this.options.runId,
      path,
      instance,
      model,
    });
  }

  private async callAgent(
    call: Omit<AgentCall, "signal"> & { signal: AbortSignal },
  ): Promise<{ value: unknown; usage?: SpawnUsage; model?: string }> {
    await this.budgets.acquireAgent(this.depth);
    const release = await this.parallelism.acquire();
    try {
      if (call.signal.aborted) {
        throw call.signal.reason instanceof CancelledError
          ? call.signal.reason
          : new CancelledError("stopped");
      }
      const result = await this.options.runAgent({
        ...call,
        onProgress: (progress) => {
          this.checkPendingBudgetAbort();
          void this.recordUsageSnapshot(call.instance, progress.usage);
          this.recordEffectiveModel(call.path, call.instance, progress.model);
          call.onProgress?.(progress);
        },
      });
      // A held agent can settle immediately after detach, before the polling
      // timer runs. A pending breach must still win over that result.
      this.checkPendingBudgetAbort();
      this.recordEffectiveModel(call.path, call.instance, result.model);
      if (result.usage) {
        addUsage(this.usage, result.usage);
        // Reconcile against the final numbers: engines without progress
        // streaming report usage only here.
        await this.recordUsageSnapshot(call.instance, result.usage);
      }
      if (call.signal.aborted) {
        throw call.signal.reason instanceof CancelledError
          ? call.signal.reason
          : new CancelledError("stopped");
      }
      return {
        value: result.value,
        usage: result.usage,
        model: result.model,
      };
    } finally {
      release();
    }
  }

  private async evaluateAgent(
    node: AgentNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<{ value: unknown; usage?: SpawnUsage }> {
    const task = renderTemplate(node.task, envResolver(env));
    return await this.callAgent({
      profile: node.profile,
      task,
      resultSchema: node.json,
      model: node.model,
      thinking: node.thinking,
      skills: node.skills,
      tools: node.tools,
      cwd: node.cwd ?? this.options.cwd,
      scope: node.scope ?? this.options.scope,
      path,
      instance,
      signal,
    });
  }

  private async evaluateSequence(
    node: SequenceNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const bindings = new Map(env.bindings);
    let previous: unknown;
    let value: unknown;
    for (let index = 0; index < node.steps.length; index++) {
      const step = node.steps[index] as FlowNode;
      const childEnv: Env = {
        ...env,
        bindings,
        hasPrevious: index > 0,
        previous,
      };
      value = await this.evaluate(
        step,
        stepPath(path, index),
        stepPath(instance, index),
        childEnv,
        signal,
      );
      if (step.as !== undefined) bindings.set(step.as, value);
      previous = value;
    }
    return value;
  }

  private async runReduce(
    reduce: Reduce,
    parentPath: string,
    parentInstance: string,
    env: Env,
    reduceRoot: { name: "branches" | "items"; value: unknown },
    signal: AbortSignal,
  ): Promise<unknown> {
    const path = reducePath(parentPath);
    const instance = reducePath(parentInstance);
    const planned = this.options.resolvePlannedModel?.({
      profile: reduce.profile,
      task: reduce.task,
      resultSchema: reduce.json,
      model: reduce.model,
      thinking: reduce.thinking,
      skills: reduce.skills,
      tools: reduce.tools,
      cwd: reduce.cwd ?? this.options.cwd,
      scope: reduce.scope ?? this.options.scope,
      path,
      instance,
      signal,
    });
    this.emit({
      type: "node_started",
      at: Date.now(),
      runId: this.options.runId,
      path,
      instance,
      kind: "reduce",
      profile: reduce.profile,
      model: planned?.model,
      requestedModel: planned?.requestedModel,
      thinking: planned?.thinking,
    });
    try {
      const task = renderTemplate(reduce.task, envResolver(env, reduceRoot));
      // A reducer is an agent call like any other: same overrides, with the
      // run's cwd and scope as the fallback.
      const result = await this.callAgent({
        profile: reduce.profile,
        task,
        resultSchema: reduce.json,
        model: reduce.model,
        thinking: reduce.thinking,
        skills: reduce.skills,
        tools: reduce.tools,
        cwd: reduce.cwd ?? this.options.cwd,
        scope: reduce.scope ?? this.options.scope,
        path,
        instance,
        signal,
      });
      this.emit({
        type: "node_completed",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        value: result.value,
        usage: result.usage,
      });
      return result.value;
    } catch (error) {
      const cancelled = cancelReasonOf(error, signal);
      if (cancelled) {
        this.emit({
          type: "node_cancelled",
          at: Date.now(),
          runId: this.options.runId,
          path,
          instance,
          reason: cancelled,
        });
        throw error instanceof CancelledError
          ? error
          : new CancelledError(cancelled);
      }
      this.emit({
        type: "node_failed",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        error: errorMessage(error),
        partialText:
          error instanceof BudgetExceededError ? error.partialText : undefined,
      });
      throw error;
    }
  }

  private async evaluateParallel(
    node: ParallelNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const entries = Object.entries(node.branches);
    const mode = node.mode ?? "all";
    const onError = node.onError ?? "fail";
    const desired =
      mode === "all" ? entries.length : mode === "any" ? 1 : mode.quorum;
    const concurrency = this.budgets.parallelismLimit(node.concurrency);

    const outcomes = await runPool(
      entries.map(([key, branch]) => ({
        key,
        run: (branchSignal: AbortSignal) =>
          this.evaluate(
            branch,
            branchPath(path, key),
            branchPath(instance, key),
            env,
            branchSignal,
          ),
      })),
      {
        concurrency,
        earlyStopAt: mode === "all" ? undefined : desired,
        earlyStopReason: mode === "any" ? "any" : "quorum",
        failFast: onError === "fail",
        requiredSuccesses:
          onError === "collect" && mode !== "all" ? desired : undefined,
        signal,
      },
    );

    // Branches cancelled before they ever started have no events yet.
    for (const outcome of outcomes) {
      if (outcome.status === "cancelled" && !outcome.started) {
        this.emit({
          type: "node_cancelled",
          at: Date.now(),
          runId: this.options.runId,
          path: branchPath(path, outcome.key),
          instance: branchPath(instance, outcome.key),
          reason: outcome.cancelReason ?? "stopped",
        });
      }
    }

    if (signal.aborted) {
      throw signal.reason instanceof CancelledError
        ? signal.reason
        : new CancelledError("stopped");
    }

    const successes = outcomes
      .filter((outcome) => outcome.status === "completed")
      .sort((a, b) => a.order - b.order);
    const failures = outcomes
      .filter((outcome) => outcome.status === "failed")
      .sort((a, b) => a.order - b.order);

    if (onError === "fail" && failures.length > 0) {
      const first = failures[0] as PoolOutcome<unknown>;
      throw new Error(
        `branch '${first.key}' failed: ${errorMessage(first.error)}`,
      );
    }
    if (
      successes.length <
      (onError === "collect" && mode === "all" ? Math.min(1, desired) : desired)
    ) {
      const details = failures
        .map((f) => `'${f.key}': ${errorMessage(f.error)}`)
        .join("; ");
      throw new Error(
        `parallel needed ${mode === "all" ? "at least 1 success" : `${desired} success(es)`} but got ${successes.length}${
          details ? ` — ${details}` : ""
        }`,
      );
    }

    let value: unknown;
    if (mode === "any") {
      value = (successes[0] as PoolOutcome<unknown>).value;
    } else {
      const collected: Record<string, unknown> = {};
      const winners = mode === "all" ? successes : successes.slice(0, desired);
      for (const outcome of winners) collected[outcome.key] = outcome.value;
      if (onError === "collect") {
        for (const failure of failures)
          collected[failure.key] = { error: errorMessage(failure.error) };
      }
      value = collected;
    }

    if (node.reduce) {
      return await this.runReduce(
        node.reduce,
        path,
        instance,
        env,
        { name: "branches", value },
        signal,
      );
    }
    return value;
  }

  private async evaluateMap(
    node: MapNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const items = resolveSingleRef(node.over, env, "map.over");
    if (!Array.isArray(items)) {
      throw new Error(
        `map.over must resolve to a JSON array, got ${items === null ? "null" : typeof items}`,
      );
    }
    const concurrency = this.budgets.parallelismLimit(node.concurrency);

    const outcomes = await runPool(
      items.map((item, index) => ({
        key: String(index),
        run: (itemSignal: AbortSignal) =>
          this.evaluate(
            node.body,
            bodyPath(path),
            `${bodyPath(instance)}@${index}`,
            { ...env, inMap: true, item, index },
            itemSignal,
          ),
      })),
      { concurrency, failFast: true, signal },
    );

    for (const outcome of outcomes) {
      if (outcome.status === "cancelled" && !outcome.started) {
        this.emit({
          type: "node_cancelled",
          at: Date.now(),
          runId: this.options.runId,
          path: bodyPath(path),
          instance: `${bodyPath(instance)}@${outcome.key}`,
          reason: outcome.cancelReason ?? "stopped",
        });
      }
    }

    if (signal.aborted) {
      throw signal.reason instanceof CancelledError
        ? signal.reason
        : new CancelledError("stopped");
    }

    const failure = outcomes
      .filter((o) => o.status === "failed")
      .sort((a, b) => a.order - b.order)[0];
    if (failure) {
      throw new Error(
        `item ${failure.key} failed: ${errorMessage(failure.error)}`,
      );
    }

    const value = outcomes.map((outcome) => outcome.value);
    if (node.reduce) {
      return await this.runReduce(
        node.reduce,
        path,
        instance,
        env,
        { name: "items", value },
        signal,
      );
    }
    return value;
  }

  private async evaluateLoop(
    node: LoopNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const limit = this.budgets.iterationLimit(node.max);
    let last: unknown;
    for (let iteration = 0; iteration < limit; iteration++) {
      if (signal.aborted) {
        throw signal.reason instanceof CancelledError
          ? signal.reason
          : new CancelledError("stopped");
      }
      this.emit({
        type: "loop_iteration",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        iteration,
      });
      last = await this.evaluate(
        node.body,
        bodyPath(path),
        `${bodyPath(instance)}#${iteration}`,
        { ...env, iterationFrame: "loop", iteration, last },
        signal,
      );
      if (node.until && evaluatePredicate(node.until, last)) break;
    }
    return last;
  }

  private async evaluateWhile(
    node: WhileNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const limit = this.budgets.iterationLimit(node.max);
    // Resolve before installing the inner frame: an inner while can seed
    // itself from the enclosing while's {current}.
    let current = resolveSingleRef(node.on, env, "while.on");
    for (let iteration = 0; iteration < limit; iteration++) {
      if (!evaluatePredicate(node.condition, current)) break;
      if (signal.aborted) {
        throw signal.reason instanceof CancelledError
          ? signal.reason
          : new CancelledError("stopped");
      }
      this.emit({
        type: "loop_iteration",
        at: Date.now(),
        runId: this.options.runId,
        path,
        instance,
        iteration,
      });
      current = await this.evaluate(
        node.body,
        bodyPath(path),
        `${bodyPath(instance)}#${iteration}`,
        { ...env, iterationFrame: "while", iteration, current },
        signal,
      );
    }
    return current;
  }

  private async evaluateSwitch(
    node: SwitchNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    const subject = resolveSingleRef(node.on, env, "switch.on");
    const index = node.cases.findIndex((arm) =>
      evaluatePredicate(arm.when, subject),
    );
    const arm = index >= 0 ? (node.cases[index] as SwitchCase).then : node.else;
    const armPath = index >= 0 ? casePath(path, index) : elsePath(path);
    const armInstance =
      index >= 0 ? casePath(instance, index) : elsePath(instance);
    return await this.evaluate(arm, armPath, armInstance, env, signal);
  }

  private async evaluateWorkflow(
    node: WorkflowRefNode,
    path: string,
    instance: string,
    env: Env,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!node.body)
      throw new Error(
        `workflow '${node.name}' was not expanded before execution`,
      );
    const params: Record<string, unknown> = {};
    for (const def of node.paramDefs ?? []) {
      const raw = node.params?.[def.name];
      params[def.name] =
        raw !== undefined
          ? resolveWorkflowParam(raw, env, def.name)
          : (def.default ?? "");
    }
    return await this.evaluate(
      node.body,
      bodyPath(path),
      bodyPath(instance),
      rootEnv(params),
      signal,
    );
  }
}
