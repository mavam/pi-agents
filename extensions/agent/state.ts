import type {
  FlowSpec,
  NodeStatus,
  RunEvent,
  RunNode,
  RunResultDetails,
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
  if (status === "completed" || status === "stopped") {
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
    case "node_stopped": {
      const node = state.nodes.get(event.nodeId);
      if (node) {
        node.error = event.error;
        setNodeStatus(node, "stopped");
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
    case "run_detached": {
      const run = state.runs.get(event.runId);
      if (run) {
        run.detachedAt = event.at;
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

export function markRunningRunsStopped(state: RunRuntimeState): void {
  for (const run of state.runs.values()) {
    if (run.status === "running") {
      run.status = "stopped";
      run.completedAt = Date.now();
      run.error = run.error ?? "Pi restarted before the run could resume.";
    }
  }

  for (const node of state.nodes.values()) {
    if (node.status === "running" || node.status === "waiting") {
      node.status = "stopped";
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

export function getRunSnapshot(
  state: RunRuntimeState,
  runId: string,
): RunResultDetails | undefined {
  const run = state.runs.get(runId);
  if (!run) return undefined;
  return structuredClone({
    run,
    nodes: getRunNodes(state, runId),
    result: run.result,
  });
}

export function countStatuses(state: RunRuntimeState): {
  runs: number;
  running: number;
  waiting: number;
} {
  let running = 0;
  let waiting = 0;
  for (const node of state.nodes.values()) {
    if (node.status === "running") running += 1;
    if (node.status === "waiting") waiting += 1;
  }
  return {
    runs: state.runs.size,
    running,
    waiting,
  };
}

export const STATUS_ICONS = {
  waiting: "○",
  running: "◉",
  completed: "●",
  stopped: "⊘",
} as const satisfies Record<NodeStatus | RunStatus, string>;

export const KIND_ICONS = {
  spawn: "✦",
  fork: "⑃",
  join: "⑂",
  loop: "↺",
  sequence: "≡",
} as const satisfies Record<FlowSpec["kind"], string>;

export function iconForStatus(status: NodeStatus | RunStatus): string {
  return STATUS_ICONS[status];
}

export function iconForKind(kind: FlowSpec["kind"]): string {
  return KIND_ICONS[kind];
}
