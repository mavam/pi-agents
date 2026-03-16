import type { RunStatus } from "./types.js";

export const AgentEvents = {
  RUN_CREATED: "run:created",
  RUN_COMPLETED: "run:completed",
  RUN_FAILED: "run:failed",
  RUN_ABORTED: "run:aborted",
  RUN_ITERATION: "run:iteration",
  AGENTS_SPAWNED: "agents:spawned",
  AGENTS_COMPLETED: "agents:completed",
  AGENTS_FAILED: "agents:failed",
  AGENTS_JOINED: "agents:joined",
} as const;

export type AgentEventChannel = (typeof AgentEvents)[keyof typeof AgentEvents];

export interface RunCreatedPayload {
  runId: string;
}

export interface RunStatusPayload {
  runId: string;
  status: Exclude<RunStatus, "running">;
}

export interface RunIterationPayload {
  runId: string;
  nodeId: string;
  iteration: number;
}

export interface AgentsSpawnedPayload {
  runId: string;
  nodeId: string;
}

export interface AgentsCompletedPayload {
  runId: string;
  nodeId: string;
}

export interface AgentsFailedPayload {
  runId: string;
  nodeId: string;
  error: string;
}

export interface AgentsJoinedPayload {
  runId: string;
  nodeId: string;
  from: string;
}

export interface AgentEventPayloads {
  [AgentEvents.RUN_CREATED]: RunCreatedPayload;
  [AgentEvents.RUN_COMPLETED]: RunStatusPayload;
  [AgentEvents.RUN_FAILED]: RunStatusPayload;
  [AgentEvents.RUN_ABORTED]: RunStatusPayload;
  [AgentEvents.RUN_ITERATION]: RunIterationPayload;
  [AgentEvents.AGENTS_SPAWNED]: AgentsSpawnedPayload;
  [AgentEvents.AGENTS_COMPLETED]: AgentsCompletedPayload;
  [AgentEvents.AGENTS_FAILED]: AgentsFailedPayload;
  [AgentEvents.AGENTS_JOINED]: AgentsJoinedPayload;
}
