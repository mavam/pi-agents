import type { Agent, Scope, Thinking } from "../agents.js";
import type { AgentRunDetails } from "../types.js";

export interface SpawnUpdate {
  text: string;
  details: AgentRunDetails;
}

export interface SpawnResult {
  id: string;
  runId?: string;
  parentNodeId?: string;
  depth: number;
  agent: string;
  text: string;
  exitCode: number;
  usage: AgentRunDetails["usage"];
  model?: string;
  details: AgentRunDetails;
}

export interface SpawnHandle {
  id: string;
  runId?: string;
  parentNodeId?: string;
  depth: number;
  status: "queued" | "running" | "completed" | "failed" | "stopped" | "aborted";
  updates: AsyncIterable<SpawnUpdate>;
  wait(): Promise<SpawnResult>;
  abort(): Promise<void>;
  capabilities?: {
    steer: boolean;
    resume: boolean;
    transcript: boolean;
  };
}

export interface SpawnRequest {
  agent: Agent;
  task: string;
  cwd: string;
  scope: Scope;
  discoveryDiagnostics: string[];
  runId?: string;
  parentNodeId?: string;
  depth?: number;
  env?: Record<string, string>;
  defaultModel?: string;
  defaultThinking?: Thinking;
}

export interface SpawnEngine {
  spawn(spec: SpawnRequest): SpawnHandle;
}
