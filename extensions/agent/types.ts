import type { Scope, Source, Thinking } from "./agents.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface AgentRunDetails {
  agent: string;
  agentSource: Source | "unknown";
  model?: string;
  thinking?: Thinking;
  skills: string[];
  missingSkills: string[];
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  usage: UsageStats;
  discoveryDiagnostics: string[];
  scope: Scope;
}

export interface Budgets {
  maxDepth?: number;
  maxChildren?: number;
  maxParallelism?: number;
  maxIterations?: number;
}

export type FlowSpec =
  | SpawnFlowSpec
  | SequenceFlowSpec
  | ForkFlowSpec
  | JoinFlowSpec
  | LoopFlowSpec;

export interface SpawnFlowSpec {
  kind: "spawn";
  id?: string;
  label?: string;
  agent: string;
  task: string;
  cwd?: string;
  scope?: Scope;
  output?: "text" | "json";
}

export interface SequenceFlowSpec {
  kind: "sequence";
  id?: string;
  label?: string;
  steps: FlowSpec[];
}

export interface ForkFlowSpec {
  kind: "fork";
  id: string;
  label?: string;
  branches: Record<string, FlowSpec>;
  concurrency?: number;
}

export type JoinReducerSpec =
  | { kind: "collect" }
  | {
      kind: "agent";
      agent: string;
      task: string;
      output?: "text" | "json";
    };

export interface JoinFlowSpec {
  kind: "join";
  id?: string;
  label?: string;
  from: string;
  mode: "all" | "any" | "quorum";
  quorum?: number;
  reducer?: JoinReducerSpec;
  onFailure?: "failFast" | "collectErrors";
}

export type ContinueSpec = {
  kind: "result_field";
  path: string;
  equals: boolean;
};

export interface LoopFlowSpec {
  kind: "loop";
  id: string;
  label?: string;
  body: FlowSpec;
  maxIterations: number;
  continueWhen?: ContinueSpec;
}

export interface WorkflowParams {
  label?: string;
  flow: FlowSpec;
  budgets?: Budgets;
  cwd?: string;
  scope?: Scope;
}

export type NodeStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface WorkflowRun {
  id: string;
  parentRunId?: string;
  parentNodeId?: string;
  rootNodeId: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  depth: number;
  flow: FlowSpec;
  budgets?: Budgets;
  cwd: string;
  scope: Scope;
  result?: FlowNodeResult;
  error?: string;
}

export interface RunNode {
  id: string;
  runId: string;
  parentNodeId?: string;
  specId?: string;
  kind: FlowSpec["kind"];
  label?: string;
  status: NodeStatus;
  iteration?: number;
  branchKey?: string;
  childRunIds?: string[];
  output?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SpawnNodeResult {
  nodeId: string;
  specId?: string;
  kind: "spawn";
  status: "completed";
  text: string;
  output: unknown;
  agent: string;
  run: AgentRunDetails;
}

export interface SequenceNodeResult {
  nodeId: string;
  specId?: string;
  kind: "sequence";
  status: "completed";
  steps: FlowNodeResult[];
  output: unknown;
}

export interface ForkBranchResult {
  branchKey: string;
  result?: FlowNodeResult;
  error?: string;
}

export interface ForkNodeResult {
  nodeId: string;
  specId?: string;
  kind: "fork";
  status: "completed";
  branches: Record<string, ForkBranchResult>;
  output: {
    branches: Record<string, unknown>;
    errors: Record<string, string>;
  };
}

export interface JoinNodeResult {
  nodeId: string;
  specId?: string;
  kind: "join";
  status: "completed";
  selectedBranches: string[];
  output: unknown;
}

export interface LoopNodeResult {
  nodeId: string;
  specId?: string;
  kind: "loop";
  status: "completed";
  iterations: FlowNodeResult[];
  output: unknown;
}

export type FlowNodeResult =
  | SpawnNodeResult
  | SequenceNodeResult
  | ForkNodeResult
  | JoinNodeResult
  | LoopNodeResult;

export interface RunResultDetails {
  run: WorkflowRun;
  nodes: RunNode[];
  result?: FlowNodeResult;
}

export type RunEvent =
  | {
      type: "run_created";
      at: number;
      run: WorkflowRun;
    }
  | {
      type: "node_started";
      at: number;
      node: RunNode;
    }
  | {
      type: "node_waiting";
      at: number;
      runId: string;
      nodeId: string;
      status: Extract<NodeStatus, "waiting">;
    }
  | {
      type: "node_completed";
      at: number;
      runId: string;
      nodeId: string;
      output?: unknown;
    }
  | {
      type: "node_failed";
      at: number;
      runId: string;
      nodeId: string;
      error: string;
    }
  | {
      type: "node_aborted";
      at: number;
      runId: string;
      nodeId: string;
      error?: string;
    }
  | {
      type: "loop_iteration_started";
      at: number;
      runId: string;
      nodeId: string;
      iteration: number;
    }
  | {
      type: "loop_iteration_completed";
      at: number;
      runId: string;
      nodeId: string;
      iteration: number;
    }
  | {
      type: "run_completed";
      at: number;
      runId: string;
      status: RunStatus;
      result?: FlowNodeResult;
      error?: string;
    };
