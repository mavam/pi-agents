/**
 * RunManager: owns live run state, starts and stops runs, and fans run
 * events out to sinks (UI refresh, persistence).
 */

import {
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
} from "../catalog/agents.js";
import type { SpawnEngine, SpawnHandle } from "../engine/types.js";
import {
  type Budgets,
  DEFAULT_BUDGETS,
  type EffectiveBudgets,
  effectiveScope as effectiveScopeFor,
  type FlowNode,
  type Scope,
} from "../model/ast.js";
import { collectAgentRequirements } from "../model/validate.js";
import { validateBudgets } from "./budgets.js";
import type { RunEvent, RunSource, SteeringSource } from "./events.js";
import {
  type AgentRunner,
  executeFlow,
  type RunOutcome,
} from "./interpreter.js";
import { createAgentRunner, type SpawnDefaults } from "./runner.js";
import {
  applyRunEvent,
  createRunState,
  type RunState,
  type RunView,
} from "./state.js";

export interface RunManagerOptions {
  engine: SpawnEngine;
  /** Cross-process delegation depth of this pi process. */
  depth?: number;
  /** Budget limits inherited from the parent process (PI_AGENTS_BUDGETS). */
  defaultBudgets?: Budgets;
  /** Internal sink for every run event (for example, notifications). */
  onEvent?: (event: RunEvent) => void;
  /** Called after state changed (widget/UI refresh). */
  onStateChanged?: (runId: string) => void;
  /** Best-effort external publication, called after all internal sinks. */
  publish?: (event: RunEvent) => void;
}

export interface StartRunOptions {
  /** Expanded, validated flow (from validateFlow). */
  flow: FlowNode;
  cwd: string;
  scope?: Scope;
  label?: string;
  params?: Record<string, unknown>;
  budgets?: Budgets;
  source: RunSource;
  originSessionFile?: string;
  /** Session defaults for agents without explicit model/thinking frontmatter. */
  defaults?: SpawnDefaults;
  /**
   * Project trust (ctx.isProjectTrusted()). When false, all agent discovery —
   * run-level and per-node overrides alike — clamps to user scope.
   */
  trusted?: boolean;
  /** Per-run event sink (persistence into the origin session). */
  onEvent?: (event: RunEvent) => void;
}

export interface StartedRun {
  runId: string;
  done: Promise<RunOutcome>;
}

export type RunLookup =
  | { kind: "found"; run: RunView }
  | { kind: "ambiguous"; matches: RunView[] }
  | { kind: "missing" };

export const MAX_STEERING_MESSAGE_CHARS = 2_000;

export type SteerResult =
  | { status: "queued"; runId: string; instance: string }
  | {
      status: "unavailable";
      reason: "run_not_live" | "instance_not_steerable";
    }
  | { status: "rejected"; error: string };

interface LiveHandle {
  handle: SpawnHandle;
  path: string;
}

export function normalizeSteeringMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized) throw new Error("steering message must not be empty");
  if (normalized.length > MAX_STEERING_MESSAGE_CHARS) {
    throw new Error(
      `steering message must be at most ${MAX_STEERING_MESSAGE_CHARS} characters`,
    );
  }
  return normalized;
}

export class RunManager {
  readonly state: RunState = createRunState();
  private readonly options: RunManagerOptions;
  private readonly controllers = new Map<string, AbortController>();
  private readonly persisters = new Map<string, (event: RunEvent) => void>();
  private readonly liveHandles = new Map<string, Map<string, LiveHandle>>();

  constructor(options: RunManagerOptions) {
    this.options = options;
  }

  /**
   * Verify every agent the flow can spawn resolves — using each node's
   * effective cwd/scope overrides, exactly as the runner will — before
   * anything runs.
   */
  preflight(flow: FlowNode, cwd: string, scope: Scope, trusted = true): void {
    const problems: string[] = [];
    const discoveries = new Map<string, ReturnType<typeof discoverAgents>>();
    for (const requirement of collectAgentRequirements(flow)) {
      const effectiveCwd = requirement.cwd ?? cwd;
      const effectiveScope = effectiveScopeFor(
        requirement.scope as Scope | undefined,
        trusted,
        scope,
      );
      const key = `${effectiveCwd}|${effectiveScope}`;
      let discovery = discoveries.get(key);
      if (!discovery) {
        discovery = discoverAgents(effectiveCwd, effectiveScope);
        discoveries.set(key, discovery);
      }
      const resolution = resolveAgentByName(discovery.agents, requirement.name);
      const where =
        requirement.cwd || requirement.scope
          ? ` (cwd: ${effectiveCwd}, scope: ${effectiveScope})`
          : "";
      if (resolution.kind === "missing") {
        // A same-named file that failed to parse is the likely culprit —
        // surface its diagnostic instead of a bare "unknown".
        const related = discovery.diagnostics.filter((diagnostic) =>
          diagnostic.filePath.includes(`/${requirement.name}.`),
        );
        const hint = related.length
          ? ` (${related.map((d) => `${d.filePath}: ${d.message}`).join("; ")})`
          : "";
        problems.push(
          `unknown agent '${requirement.name}'${where}. Available: ${formatAgentList(discovery.agents)}${hint}`,
        );
      } else if (resolution.kind === "ambiguous")
        problems.push(
          `ambiguous agent '${requirement.name}'${where} (${resolution.matches.map((a) => a.name).join(", ")})`,
        );
    }
    if (problems.length > 0) {
      throw new Error(`cannot start run: ${problems.join("; ")}`);
    }
  }

  start(opts: StartRunOptions): StartedRun {
    const trusted = opts.trusted ?? true;
    const scope = effectiveScopeFor(opts.scope, trusted);
    validateBudgets(opts.budgets);
    this.preflight(opts.flow, opts.cwd, scope, trusted);
    const budgets: Budgets = {
      ...this.options.defaultBudgets,
      ...opts.budgets,
    };
    const budgetLimits: EffectiveBudgets = { ...DEFAULT_BUDGETS, ...budgets };

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    if (opts.onEvent) this.persisters.set(runId, opts.onEvent);

    const emit = (event: RunEvent): void => this.emit(runId, event);

    const baseRunner = createAgentRunner({
      engine: this.options.engine,
      cwd: opts.cwd,
      scope,
      trusted,
      depth: this.options.depth,
      defaults: opts.defaults,
      budgetLimits,
      onHandle: (call, handle) => {
        let handles = this.liveHandles.get(runId);
        if (!handles) {
          handles = new Map();
          this.liveHandles.set(runId, handles);
        }
        const live = { handle, path: call.path };
        handles.set(call.instance, live);
        return () => {
          const current = this.liveHandles.get(runId);
          if (current?.get(call.instance) === live) {
            current.delete(call.instance);
            if (current.size === 0) this.liveHandles.delete(runId);
          }
        };
      },
    });
    const runner: AgentRunner = (call) =>
      baseRunner({
        ...call,
        onProgress: (progress) => {
          // The interpreter's own listener (run-level budgets) comes first.
          call.onProgress?.(progress);
          const node = this.state.runs.get(runId)?.nodes.get(call.instance);
          if (node) {
            node.progressText = progress.text;
            node.progressUsage = progress.usage;
            node.progressTool = progress.currentTool;
            node.lastProgressAt = Date.now();
          }
          this.options.onStateChanged?.(runId);
        },
      });

    const done = executeFlow({
      runId,
      flow: opts.flow,
      runAgent: runner,
      emit,
      label: opts.label,
      source: opts.source,
      params: opts.params,
      budgets,
      depth: this.options.depth,
      signal: controller.signal,
      cwd: opts.cwd,
      scope,
      originSessionFile: opts.originSessionFile,
    }).finally(() => {
      this.controllers.delete(runId);
      this.persisters.delete(runId);
      this.liveHandles.delete(runId);
    });

    return { runId, done };
  }

  /** Record that a run moved to the background (persisted like any event). */
  markBackgrounded(runId: string): void {
    const event: RunEvent = { type: "run_backgrounded", at: Date.now(), runId };
    this.emit(runId, event);
  }

  /** Apply one event and fan it out in internal-before-external order. */
  private emit(runId: string, event: RunEvent): void {
    applyRunEvent(this.state, event);
    this.persisters.get(runId)?.(event);
    this.options.onEvent?.(event);
    this.options.onStateChanged?.(runId);
    try {
      this.options.publish?.(event);
    } catch {
      // Public observers must never be able to interrupt execution.
    }
  }

  /**
   * Merge replayed history (from session entries) into live state. Runs that
   * are live in this process are left untouched; replayed runs still marked
   * "running" cannot resume and are marked stopped.
   */
  absorbHistory(events: Iterable<RunEvent>): void {
    const rebuilt = createRunState();
    for (const event of events) applyRunEvent(rebuilt, event);
    for (const [runId, run] of rebuilt.runs) {
      if (this.isLive(runId)) continue;
      if (run.status === "running") {
        run.status = "stopped";
        run.error = "Pi restarted before the run could resume.";
        for (const node of run.nodes.values()) {
          if (node.status === "running") {
            node.status = "cancelled";
            node.cancelReason = "stopped";
          }
        }
      }
      if (!this.state.runs.has(runId)) this.state.order.push(runId);
      this.state.runs.set(runId, run);
    }
  }

  /** Abort a live run. Returns false when the run is not live. */
  stop(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  isLive(runId: string): boolean {
    return this.controllers.has(runId);
  }

  liveRunIds(): string[] {
    return [...this.controllers.keys()];
  }

  /** Exact instance ids of live child processes that support steering. */
  steerableInstances(runId: string): string[] {
    const handles = this.liveHandles.get(runId);
    if (!handles) return [];
    return [...handles.entries()].flatMap(([instance, live]) =>
      live.handle.status === "running" && live.handle.steer ? [instance] : [],
    );
  }

  /** Queue a correction for one live child and persist it after acceptance. */
  async steer(
    runId: string,
    instance: string,
    message: string,
    source: SteeringSource,
    caller?: string,
  ): Promise<SteerResult> {
    let normalized: string;
    try {
      normalized = normalizeSteeringMessage(message);
    } catch (error) {
      return {
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!this.controllers.has(runId)) {
      return { status: "unavailable", reason: "run_not_live" };
    }
    const live = this.liveHandles.get(runId)?.get(instance);
    if (!live?.handle.steer || live.handle.status !== "running") {
      return { status: "unavailable", reason: "instance_not_steerable" };
    }
    try {
      await live.handle.steer(normalized);
    } catch (error) {
      return {
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.emit(runId, {
      type: "node_steered",
      at: Date.now(),
      runId,
      path: live.path,
      instance,
      message: normalized,
      source,
      caller,
    });
    return { status: "queued", runId, instance };
  }

  /** Find a run by full id or unique prefix. */
  find(idOrPrefix: string): RunLookup {
    const exact = this.state.runs.get(idOrPrefix);
    if (exact) return { kind: "found", run: exact };
    const matches = [...this.state.runs.values()].filter((run) =>
      run.header.id.startsWith(idOrPrefix),
    );
    if (matches.length === 1)
      return { kind: "found", run: matches[0] as RunView };
    if (matches.length > 1) return { kind: "ambiguous", matches };
    return { kind: "missing" };
  }
}
