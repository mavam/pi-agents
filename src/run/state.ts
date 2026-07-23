/**
 * Run state: the reducer over run events plus rebuild helpers. The same
 * reducer serves live runs (events applied as they happen) and history
 * (events replayed from session entries).
 */

import type { SpawnUsage } from "../engine/types.js";
import type { NodeKind } from "../model/ast.js";
import type {
  CancelReason,
  NodeStatus,
  RunEvent,
  RunHeader,
  RunStatus,
  SteeringSource,
} from "./events.js";

export interface SteeringEntry {
  at: number;
  message: string;
  source: SteeringSource;
  caller?: string;
}

export interface NodeView {
  path: string;
  instance: string;
  kind: NodeKind | "reduce";
  agent?: string;
  label?: string;
  status: NodeStatus;
  value?: unknown;
  error?: string;
  cancelReason?: CancelReason;
  usage?: SpawnUsage;
  /** Latest streamed output preview. In-memory only; never persisted. */
  progressText?: string;
  /** Latest streamed usage of a running agent. In-memory only. */
  progressUsage?: SpawnUsage;
  /** Accepted steering messages in delivery order. */
  steering: SteeringEntry[];
  startedAt: number;
  endedAt?: number;
}

export interface RunView {
  header: RunHeader;
  status: RunStatus;
  /** Node instances in first-seen order, keyed by instance id. */
  nodes: Map<string, NodeView>;
  order: string[];
  /** Iterations seen per loop instance. */
  loopIterations: Map<string, number>;
  backgrounded: boolean;
  value?: unknown;
  error?: string;
  usage?: SpawnUsage;
  agents?: number;
  createdAt: number;
  endedAt?: number;
}

export interface RunState {
  runs: Map<string, RunView>;
  order: string[];
}

export function createRunState(): RunState {
  return { runs: new Map(), order: [] };
}

export function applyRunEvent(state: RunState, event: RunEvent): void {
  if (event.type === "run_created") {
    if (state.runs.has(event.run.id)) return;
    state.runs.set(event.run.id, {
      header: event.run,
      status: "running",
      nodes: new Map(),
      order: [],
      loopIterations: new Map(),
      backgrounded: false,
      createdAt: event.at,
    });
    state.order.push(event.run.id);
    return;
  }
  const run = state.runs.get(event.runId);
  if (!run) return;
  switch (event.type) {
    case "node_started": {
      if (run.nodes.has(event.instance)) return;
      run.nodes.set(event.instance, {
        path: event.path,
        instance: event.instance,
        kind: event.kind,
        agent: event.agent,
        label: event.label,
        status: "running",
        steering: [],
        startedAt: event.at,
      });
      run.order.push(event.instance);
      return;
    }
    case "node_completed": {
      const node = run.nodes.get(event.instance);
      if (!node) return;
      node.status = "completed";
      node.value = event.value;
      node.usage = event.usage;
      node.endedAt = event.at;
      return;
    }
    case "node_failed": {
      const node = run.nodes.get(event.instance);
      if (!node) return;
      node.status = "failed";
      node.error = event.error;
      node.endedAt = event.at;
      return;
    }
    case "node_cancelled": {
      // Cancelled-before-start branches have no node_started; materialize them.
      let node = run.nodes.get(event.instance);
      if (!node) {
        node = {
          path: event.path,
          instance: event.instance,
          kind: "agent",
          status: "cancelled",
          steering: [],
          startedAt: event.at,
        };
        run.nodes.set(event.instance, node);
        run.order.push(event.instance);
      }
      node.status = "cancelled";
      node.cancelReason = event.reason;
      node.endedAt = event.at;
      return;
    }
    case "node_steered": {
      const node = run.nodes.get(event.instance);
      if (!node) return;
      node.steering.push({
        at: event.at,
        message: event.message,
        source: event.source,
        caller: event.caller,
      });
      return;
    }
    case "loop_iteration": {
      run.loopIterations.set(event.instance, event.iteration + 1);
      return;
    }
    case "run_backgrounded": {
      run.backgrounded = true;
      return;
    }
    case "run_completed": {
      run.status = event.status;
      run.value = event.value;
      run.error = event.error;
      run.usage = event.usage;
      run.agents = event.agents;
      run.endedAt = event.at;
      return;
    }
  }
}

/** The run's work leaves (agents and reduces) in first-seen order; composite
 * scaffolding nodes (sequence/parallel/map/loop/workflow) are skipped. */
export function workNodes(run: RunView): NodeView[] {
  return run.order
    .map((instance) => run.nodes.get(instance))
    .filter(
      (node): node is NodeView =>
        node !== undefined && (node.kind === "agent" || node.kind === "reduce"),
    );
}

export function rebuildRunState(events: Iterable<RunEvent>): RunState {
  const state = createRunState();
  for (const event of events) applyRunEvent(state, event);
  return state;
}

/**
 * After a pi restart, in-flight runs cannot resume: mark them (and their
 * running nodes) stopped with an explanatory error.
 */
export function markRunningRunsStopped(
  state: RunState,
  note = "Pi restarted before the run could resume.",
): void {
  for (const run of state.runs.values()) {
    if (run.status !== "running") continue;
    run.status = "stopped";
    run.error = note;
    for (const node of run.nodes.values()) {
      if (node.status === "running") {
        node.status = "cancelled";
        node.cancelReason = "stopped";
      }
    }
  }
}
