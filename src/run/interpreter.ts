/**
 * The flow interpreter: evaluates an expanded, validated flow tree against an
 * environment of explicit bindings, emitting run events along the way.
 *
 * Every node yields a JSON value. Data flows only through `as` bindings,
 * `{previous}`, map item frames, loop iteration frames, and workflow params —
 * nothing is injected implicitly.
 */

import { addUsage, emptyUsage, type SpawnUsage } from "../engine/types.js";
import {
  type AgentNode,
  type Budgets,
  bodyPath,
  branchPath,
  type FlowNode,
  type LoopNode,
  type MapNode,
  type OutputMode,
  type ParNode,
  type Reduce,
  reducePath,
  type Scope,
  type SeqNode,
  stepPath,
  type WorkflowRefNode,
} from "../model/ast.js";
import {
  type RootResolver,
  renderTemplate,
  resolvePath,
  templateRefs,
} from "../model/interpolate.js";
import { evaluatePredicate } from "../model/predicate.js";
import { BudgetActor, Semaphore } from "./budgets.js";
import type { CancelReason, RunEvent, RunSource, RunStatus } from "./events.js";
import { CancelledError, type PoolOutcome, runPool } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Agent runner abstraction (implemented over the spawn engine; faked in tests)

export interface AgentCall {
  agent: string;
  task: string;
  output: OutputMode;
  cwd?: string;
  scope?: Scope;
  path: string;
  instance: string;
  signal: AbortSignal;
  onProgress?: (text: string, usage?: SpawnUsage) => void;
}

export interface AgentResult {
  text: string;
  usage?: SpawnUsage;
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
  inLoop: boolean;
  iteration?: number;
  last?: unknown;
}

function rootEnv(params: Record<string, unknown>): Env {
  return {
    bindings: new Map(),
    params,
    hasPrevious: false,
    inMap: false,
    inLoop: false,
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
        return env.inLoop
          ? { found: true, value: env.iteration }
          : { found: false };
      case "last":
        return env.inLoop ? { found: true, value: env.last } : { found: false };
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

// ---------------------------------------------------------------------------
// JSON output parsing

/** Parse an agent's `output: "json"` text, tolerating ```json fences. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  const body = (fence ? fence[1] : trimmed) as string;
  try {
    return JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const preview = body.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `expected JSON output but parsing failed (${detail}); output starts with: ${preview}`,
    );
  }
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

class Interpreter {
  private readonly options: ExecuteOptions;
  private readonly budgets: BudgetActor;
  /** Caps simultaneously running agents globally, across nested pools. */
  private readonly parallelism: Semaphore;
  private readonly usage: SpawnUsage = emptyUsage();
  private readonly depth: number;

  constructor(options: ExecuteOptions) {
    this.options = options;
    this.budgets = new BudgetActor(options.budgets);
    this.parallelism = new Semaphore(this.budgets.limits.maxParallelism);
    this.depth = options.depth ?? 0;
  }

  private emit(event: RunEvent): void {
    this.options.emit?.(event);
  }

  async run(): Promise<RunOutcome> {
    const controller = new AbortController();
    const external = this.options.signal;
    const onExternalAbort = () =>
      controller.abort(new CancelledError("stopped"));
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });

    this.emit({
      type: "run_created",
      at: Date.now(),
      run: {
        id: this.options.runId,
        label: this.options.label,
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
      outcome = {
        status: cancelled ? "stopped" : "failed",
        error: cancelled ? "Run stopped." : errorMessage(error),
        usage: { ...this.usage },
        agents: await this.budgets.usedAgents(),
      };
    } finally {
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
    this.emit({
      type: "node_started",
      at: Date.now(),
      runId: this.options.runId,
      path,
      instance,
      kind: node.kind,
      agent: node.kind === "agent" ? node.name : undefined,
      label: node.label,
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
      case "seq":
        return {
          value: await this.evaluateSeq(node, path, instance, env, signal),
        };
      case "par":
        return {
          value: await this.evaluatePar(node, path, instance, env, signal),
        };
      case "map":
        return {
          value: await this.evaluateMap(node, path, instance, env, signal),
        };
      case "loop":
        return {
          value: await this.evaluateLoop(node, path, instance, env, signal),
        };
      case "workflow":
        return {
          value: await this.evaluateWorkflow(node, path, instance, env, signal),
        };
    }
  }

  private async callAgent(
    call: Omit<AgentCall, "signal"> & { signal: AbortSignal },
  ): Promise<{ value: unknown; usage?: SpawnUsage }> {
    await this.budgets.acquireAgent(this.depth);
    const release = await this.parallelism.acquire();
    try {
      if (call.signal.aborted) {
        throw call.signal.reason instanceof CancelledError
          ? call.signal.reason
          : new CancelledError("stopped");
      }
      const result = await this.options.runAgent(call);
      if (result.usage) addUsage(this.usage, result.usage);
      const value =
        call.output === "json" ? parseJsonOutput(result.text) : result.text;
      return { value, usage: result.usage };
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
      agent: node.name,
      task,
      output: node.output ?? "text",
      cwd: node.cwd ?? this.options.cwd,
      scope: node.scope ?? this.options.scope,
      path,
      instance,
      signal,
    });
  }

  private async evaluateSeq(
    node: SeqNode,
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
    this.emit({
      type: "node_started",
      at: Date.now(),
      runId: this.options.runId,
      path,
      instance,
      kind: "reduce",
      agent: reduce.agent,
    });
    try {
      const task = renderTemplate(reduce.task, envResolver(env, reduceRoot));
      const result = await this.callAgent({
        agent: reduce.agent,
        task,
        output: reduce.output ?? "text",
        cwd: this.options.cwd,
        scope: this.options.scope,
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
      });
      throw error;
    }
  }

  private async evaluatePar(
    node: ParNode,
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
        `par needed ${mode === "all" ? "at least 1 success" : `${desired} success(es)`} but got ${successes.length}${
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
    const ref = templateRefs(node.over)[0];
    if (!ref) throw new Error(`map.over is not a reference: '${node.over}'`);
    const root = envResolver(env)(ref.root);
    if (!root.found) throw new Error(`map.over: unknown reference ${ref.raw}`);
    const resolved =
      ref.path.length === 0 ? root : resolvePath(root.value, ref.path);
    if (!resolved.found) {
      throw new Error(
        `map.over: path '${ref.path.join(".")}' not found in {${ref.root}}`,
      );
    }
    if (!Array.isArray(resolved.value)) {
      throw new Error(
        `map.over must resolve to a JSON array, got ${resolved.value === null ? "null" : typeof resolved.value}`,
      );
    }
    const items = resolved.value;
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
        { ...env, inLoop: true, iteration, last },
        signal,
      );
      if (node.until && evaluatePredicate(node.until, last)) break;
    }
    return last;
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
          ? renderTemplate(raw, envResolver(env))
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
