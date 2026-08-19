/**
 * RunManager: owns live run state, starts and stops runs, and fans run
 * events out to sinks (UI refresh, persistence).
 */

import * as os from "node:os";
import * as path from "node:path";
import type { SpawnEngine, SpawnHandle } from "../engine/types.js";
import {
  type Budgets,
  DEFAULT_BUDGETS,
  type EffectiveBudgets,
  effectiveScope as effectiveScopeFor,
  type FlowNode,
  type Scope,
} from "../model/ast.js";
import { collectInvocations } from "../model/validate.js";
import { validateBudgets } from "./budgets.js";
import type { RunEvent, RunSource } from "./events.js";
import {
  type AgentRunner,
  executeFlow,
  type RunOutcome,
} from "./interpreter.js";
import {
  CatalogCache,
  type ResolveModel,
  resolveInvocation,
} from "./invocation.js";
import { createAgentRunner, type SpawnDefaults } from "./runner.js";
import {
  applyRunEvent,
  createRunState,
  type RunState,
  type RunView,
} from "./state.js";

export interface RunManagerOptions {
  engine: SpawnEngine;
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
  /** Saved-workflow result path selected for human-facing rendering. */
  display?: string;
  params?: Record<string, unknown>;
  budgets?: Budgets;
  source: RunSource;
  originSessionFile?: string;
  /** Session defaults for agents without explicit model/thinking frontmatter. */
  defaults?: SpawnDefaults;
  /** Resolve explicit node/profile models to provider-qualified ids. */
  resolveModel?: ResolveModel;
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

interface LiveHandle {
  handle: SpawnHandle;
  path: string;
}

/** Directory for one run's delegated-agent session files: pi-agents-owned,
 * outside the project's default session store so the picker stays clean. */
export function agentSessionDir(runId: string): string {
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "sessions",
    "pi-agents",
    runId,
  );
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
   * Verify every invocation the flow can spawn resolves — profiles and skills
   * alike, under each node's own cwd/scope overrides — before anything runs.
   *
   * The resolver owns cwd, scope, and message text; preflight only names the
   * node and accumulates, so a flow reports all of its problems at once and
   * reports them exactly as the runner would.
   */
  preflight(
    flow: FlowNode,
    cwd: string,
    scope: Scope,
    trusted = true,
    catalogs: CatalogCache = new CatalogCache(),
    resolveModel?: ResolveModel,
  ): void {
    const problems: string[] = [];
    for (const requirement of collectInvocations(flow)) {
      const resolution = resolveInvocation(requirement, {
        cwd,
        scope,
        trusted,
        resolveModel,
        catalogs,
      });
      if (resolution.ok) continue;
      for (const problem of resolution.problems)
        problems.push(`at ${requirement.path}, ${problem}`);
    }
    if (problems.length > 0) {
      throw new Error(`cannot start run: ${problems.join("; ")}`);
    }
  }

  start(opts: StartRunOptions): StartedRun {
    const trusted = opts.trusted ?? true;
    const scope = effectiveScopeFor(opts.scope, trusted);
    validateBudgets(opts.budgets);
    // One cache for the whole run: preflight's profile and skill reads serve
    // every later spawn, so nothing is discovered or read twice.
    const catalogs = new CatalogCache();
    this.preflight(
      opts.flow,
      opts.cwd,
      scope,
      trusted,
      catalogs,
      opts.resolveModel,
    );
    const budgets: Budgets = { ...opts.budgets };
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
      defaults: opts.defaults,
      resolveModel: opts.resolveModel,
      budgetLimits,
      catalogs,
      sessionDir: agentSessionDir(runId),
      onHandle: (call, handle) => {
        let handles = this.liveHandles.get(runId);
        if (!handles) {
          handles = new Map();
          this.liveHandles.set(runId, handles);
        }
        const live = { handle, path: call.path };
        handles.set(call.instance, live);
        // Persist the child's session file as soon as it is known, so the
        // agent stays attachable after it finishes (and across restarts).
        void handle.nativeSession?.then((sessionFile) => {
          if (!sessionFile) return;
          this.emit(runId, {
            type: "node_session",
            at: Date.now(),
            runId,
            path: call.path,
            instance: call.instance,
            sessionFile,
          });
        });
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
            const now = Date.now();
            node.progressText = progress.text;
            if (progress.summary !== node.progressSummary) {
              node.progressSummary = progress.summary;
              if (progress.summary !== undefined) node.progressSummaryAt = now;
            }
            node.progressUsage = progress.usage;
            node.progressTool = progress.currentTool;
            node.lastProgressAt = now;
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
      display: opts.display,
      source: opts.source,
      params: opts.params,
      budgets,
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

  /** The live spawn handle for one node instance, when its child is running.
   * The interactive agent console attaches through this. */
  liveHandle(runId: string, instance: string): SpawnHandle | undefined {
    const live = this.liveHandles.get(runId)?.get(instance);
    return live?.handle.status === "running" ? live.handle : undefined;
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
