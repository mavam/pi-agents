import type {
  CompositionEvent,
  CompositionNode,
  CompositionRun,
  CompositionStatus,
  NodeStatus,
} from "./types.js";

export interface CompositionRuntimeState {
  runs: Map<string, CompositionRun>;
  nodes: Map<string, CompositionNode>;
  order: string[];
}

export function createCompositionRuntimeState(): CompositionRuntimeState {
  return {
    runs: new Map(),
    nodes: new Map(),
    order: [],
  };
}

function setNodeStatus(
  node: CompositionNode | undefined,
  status: NodeStatus,
): void {
  if (!node) return;
  node.status = status;
  if (status === "running" && node.startedAt === undefined) {
    node.startedAt = Date.now();
  }
  if (status === "completed" || status === "failed" || status === "aborted") {
    node.completedAt = Date.now();
  }
}

export function applyCompositionEvent(
  state: CompositionRuntimeState,
  event: CompositionEvent,
): void {
  switch (event.type) {
    case "composition_created": {
      state.runs.set(event.composition.id, { ...event.composition });
      if (!state.order.includes(event.composition.id)) {
        state.order.push(event.composition.id);
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
    case "composition_completed": {
      const run = state.runs.get(event.compositionId);
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

export function markRunningCompositionsAborted(
  state: CompositionRuntimeState,
): void {
  for (const run of state.runs.values()) {
    if (run.status === "running") {
      run.status = "aborted";
      run.completedAt = Date.now();
      run.error =
        run.error ?? "Pi restarted before the composition could resume.";
    }
  }

  for (const node of state.nodes.values()) {
    if (node.status === "running" || node.status === "waiting") {
      node.status = "aborted";
      node.completedAt = Date.now();
      node.error =
        node.error ?? "Pi restarted before the composition could resume.";
    }
  }
}

export function getCompositionNodes(
  state: CompositionRuntimeState,
  compositionId: string,
): CompositionNode[] {
  return [...state.nodes.values()]
    .filter((node) => node.compositionId === compositionId)
    .sort((a, b) => {
      const left = a.startedAt ?? 0;
      const right = b.startedAt ?? 0;
      return left - right || a.id.localeCompare(b.id);
    });
}

export function getOrderedCompositions(
  state: CompositionRuntimeState,
): CompositionRun[] {
  return state.order
    .map((id) => state.runs.get(id))
    .filter((run): run is CompositionRun => run !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function countStatuses(state: CompositionRuntimeState): {
  compositions: number;
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
    compositions: state.runs.size,
    running,
    waiting,
    queued,
  };
}

export function iconForStatus(status: NodeStatus | CompositionStatus): string {
  switch (status) {
    case "running":
      return "⠹";
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
