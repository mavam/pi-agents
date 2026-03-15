import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Agent, Scope } from "../agents.js";
import type { AgentRunDetails } from "../types.js";

export interface SpawnUpdate {
  text: string;
  details: AgentRunDetails;
}

export interface SpawnResult {
  id: string;
  compositionId?: string;
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
  compositionId?: string;
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
  compositionId?: string;
  parentNodeId?: string;
  depth?: number;
  env?: Record<string, string>;
}

export interface SpawnEngine {
  spawn(spec: SpawnRequest, ctx: ExtensionContext): SpawnHandle;
}
