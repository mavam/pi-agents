/**
 * RunManager: owns live run state, starts and stops runs, and fans run
 * events out to sinks (UI refresh, persistence).
 */

import {
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
} from "../catalog/agents.js";
import type { SpawnEngine } from "../engine/types.js";
import type { Budgets, FlowNode, Scope } from "../model/ast.js";
import { collectAgentNames } from "../model/validate.js";
import type { RunEvent, RunSource } from "./events.js";
import {
  type AgentRunner,
  executeFlow,
  type RunOutcome,
} from "./interpreter.js";
import { createAgentRunner } from "./runner.js";
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
  /** Sink for every run event (persistence, notifications). */
  onEvent?: (event: RunEvent) => void;
  /** Called after state changed (widget/UI refresh). */
  onStateChanged?: (runId: string) => void;
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

export class RunManager {
  readonly state: RunState = createRunState();
  private readonly options: RunManagerOptions;
  private readonly controllers = new Map<string, AbortController>();
  private readonly persisters = new Map<string, (event: RunEvent) => void>();

  constructor(options: RunManagerOptions) {
    this.options = options;
  }

  /** Verify every agent the flow can spawn resolves, before anything runs. */
  preflight(flow: FlowNode, cwd: string, scope: Scope): void {
    const discovery = discoverAgents(cwd, scope);
    const problems: string[] = [];
    for (const name of collectAgentNames(flow)) {
      const resolution = resolveAgentByName(discovery.agents, name);
      if (resolution.kind === "missing")
        problems.push(`unknown agent '${name}'`);
      else if (resolution.kind === "ambiguous")
        problems.push(
          `ambiguous agent '${name}' (${resolution.matches.map((a) => a.name).join(", ")})`,
        );
    }
    if (problems.length > 0) {
      throw new Error(
        `cannot start run: ${problems.join("; ")}. Available agents (scope: ${scope}): ${formatAgentList(discovery.agents)}`,
      );
    }
  }

  start(opts: StartRunOptions): StartedRun {
    const scope = opts.scope ?? "both";
    this.preflight(opts.flow, opts.cwd, scope);

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    if (opts.onEvent) this.persisters.set(runId, opts.onEvent);

    const emit = (event: RunEvent): void => {
      applyRunEvent(this.state, event);
      this.persisters.get(runId)?.(event);
      this.options.onEvent?.(event);
      this.options.onStateChanged?.(runId);
    };

    const baseRunner = createAgentRunner({
      engine: this.options.engine,
      cwd: opts.cwd,
      scope,
      depth: this.options.depth,
    });
    const runner: AgentRunner = (call) =>
      baseRunner({
        ...call,
        onProgress: (text) => {
          const node = this.state.runs.get(runId)?.nodes.get(call.instance);
          if (node) node.progressText = text;
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
      budgets: opts.budgets,
      depth: this.options.depth,
      signal: controller.signal,
      cwd: opts.cwd,
      scope,
      originSessionFile: opts.originSessionFile,
    }).finally(() => {
      this.controllers.delete(runId);
      this.persisters.delete(runId);
    });

    return { runId, done };
  }

  /** Record that a run moved to the background (persisted like any event). */
  markBackgrounded(runId: string): void {
    const event: RunEvent = { type: "run_backgrounded", at: Date.now(), runId };
    applyRunEvent(this.state, event);
    this.persisters.get(runId)?.(event);
    this.options.onEvent?.(event);
    this.options.onStateChanged?.(runId);
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
