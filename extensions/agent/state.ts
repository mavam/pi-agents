import type {
  NodeStatus,
  RunEvent,
  RunNode,
  RunStatus,
  WorkflowRun,
} from "./types.js";

export interface RunRuntimeState {
  runs: Map<string, WorkflowRun>;
  nodes: Map<string, RunNode>;
  order: string[];
}

export function createRunRuntimeState(): RunRuntimeState {
  return {
    runs: new Map(),
    nodes: new Map(),
    order: [],
  };
}

function setNodeStatus(node: RunNode | undefined, status: NodeStatus): void {
  if (!node) return;
  node.status = status;
  if (status === "running" && node.startedAt === undefined) {
    node.startedAt = Date.now();
  }
  if (status === "completed" || status === "failed" || status === "aborted") {
    node.completedAt = Date.now();
  }
}

export function applyRunEvent(state: RunRuntimeState, event: RunEvent): void {
  switch (event.type) {
    case "run_created": {
      state.runs.set(event.run.id, { ...event.run });
      if (!state.order.includes(event.run.id)) {
        state.order.push(event.run.id);
      }
      return;
    }
    case "node_started": {
      state.nodes.set(event.node.id, { ...event.node });
      return;
    }
    case "node_waiting": {
      setNodeStatus(state.nodes.get(event.nodeId), event.status);
      return;
    }
    case "node_completed": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.output = event.output;
        setNodeStatus(node, "completed");
      }
      return;
    }
    case "node_failed": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.error = event.error;
        setNodeStatus(node, "failed");
      }
      return;
    }
    case "node_aborted": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.error = event.error;
        setNodeStatus(node, "aborted");
      }
      return;
    }
    case "loop_iteration_started": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.iteration = event.iteration;
        node.status = "running";
      }
      return;
    }
    case "loop_iteration_completed": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.iteration = event.iteration;
      }
      return;
    }
    case "run_completed": {
      const run = state.runs.get(event.runId);
      if (run) {
        run.status = event.status;
        run.completedAt = event.at;
        run.result = event.result;
        run.error = event.error;
      }
      return;
    }
  }
}

export function markRunningRunsAborted(state: RunRuntimeState): void {
  for (const run of state.runs.values()) {
    if (run.status === "running") {
      run.status = "aborted";
      run.completedAt = Date.now();
      run.error = run.error ?? "Pi restarted before the run could resume.";
    }
  }

  for (const node of state.nodes.values()) {
    if (node.status === "running" || node.status === "waiting") {
      node.status = "aborted";
      node.completedAt = Date.now();
      node.error = node.error ?? "Pi restarted before the run could resume.";
    }
  }
}

export function getRunNodes(state: RunRuntimeState, runId: string): RunNode[] {
  return [...state.nodes.values()]
    .filter((node) => node.runId === runId)
    .sort((a, b) => {
      const left = a.startedAt ?? 0;
      const right = b.startedAt ?? 0;
      return left - right || a.id.localeCompare(b.id);
    });
}

export function getOrderedRuns(state: RunRuntimeState): WorkflowRun[] {
  return state.order
    .map((id) => state.runs.get(id))
    .filter((run): run is WorkflowRun => run !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function countStatuses(state: RunRuntimeState): {
  runs: number;
  running: number;
  waiting: number;
  queued: number;
} {
  let running = 0;
  let waiting = 0;
  let queued = 0;
  for (const node of state.nodes.values()) {
    if (node.status === "running") running += 1;
    if (node.status === "waiting") waiting += 1;
    if (node.status === "queued") queued += 1;
  }
  return {
    runs: state.runs.size,
    running,
    waiting,
    queued,
  };
}

export function iconForStatus(
  status: NodeStatus | RunStatus,
  runningIcon = "⠹",
): string {
  switch (status) {
    case "running":
      return runningIcon;
    case "waiting":
      return "◐";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "■";
    case "queued":
      return "○";
  }
}
