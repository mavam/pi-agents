/**
 * Spawn engine abstraction: runs one delegated agent as an isolated process
 * and streams its progress. The subprocess implementation lives in
 * subprocess.ts; tests inject fakes.
 */

import type { JsonSchema } from "../model/json-schema.js";

export interface SpawnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsage(): SpawnUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function addUsage(total: SpawnUsage, delta: SpawnUsage): void {
  total.input += delta.input;
  total.output += delta.output;
  total.cacheRead += delta.cacheRead;
  total.cacheWrite += delta.cacheWrite;
  total.cost += delta.cost;
  total.contextTokens = Math.max(total.contextTokens, delta.contextTokens);
  total.turns += delta.turns;
}

export interface SpawnSpec {
  /** Agent name, for labels and error messages. */
  agent: string;
  /** The fully interpolated task prompt (sent on stdin). */
  task: string;
  cwd: string;
  /** Combined system prompt (agent body + skills), appended via temp file. */
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  /** Disable the child Pi process's ambient skill discovery. Instructions
   * already included in `systemPrompt` remain available. */
  disableSkillDiscovery?: boolean;
  /** Working-tool allowlist; the engine always adds result submission. */
  tools?: string[];
  /** Optional JSON Schema for the submitted payload. Omit for a string. */
  resultSchema?: JsonSchema;
  /** Directory for the delegated agent's own session file. Engines with
   * native sessions write a real, later-attachable session there. */
  sessionDir?: string;
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
}

export interface SpawnProgress {
  /** Latest assistant text so far. */
  text: string;
  /** Latest provider-supplied reasoning summary headline, when Pi exposes one. */
  summary?: string;
  usage: SpawnUsage;
  /** Tool currently executing, when the engine reports tool activity. */
  currentTool?: string;
  /** Assistant turns started so far (may lead usage.turns, which counts
   * completed turns). Engines that report it enable precise turn budgets. */
  turnsStarted?: number;
}

export interface SpawnOutcome {
  /** Value accepted through the delegated agent's result-submission tool. */
  value: unknown;
  exitCode: number;
  usage: SpawnUsage;
  /** Model that actually served the run, when reported. */
  model?: string;
}

/** Thrown by wait() when the delegated process fails. */
export class SpawnFailure extends Error {
  readonly agent: string;
  readonly exitCode: number;
  readonly stderr: string;

  constructor(message: string, agent: string, exitCode: number, stderr = "") {
    super(message);
    this.name = "SpawnFailure";
    this.agent = agent;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Thrown by wait() when the agent explicitly submits an error result. */
export class AgentErrorResult extends Error {
  readonly agent: string;
  readonly reason: string;

  constructor(agent: string, reason: string) {
    super(reason);
    this.name = "AgentErrorResult";
    this.agent = agent;
    this.reason = reason;
  }
}

/** Thrown by wait() when the spawn was aborted via abort(). */
export class SpawnAborted extends Error {
  constructor(agent: string) {
    super(`Agent ${agent} aborted.`);
    this.name = "SpawnAborted";
  }
}

/**
 * One entry in a delegated agent's live transcript. Engine-neutral: the
 * subprocess engine builds these from pi RPC records; other engines may map
 * their own event streams. Entries are mutable in place (streaming text and
 * tool output update the same item), identified by `key`.
 */
export type TranscriptItem =
  | { key: string; kind: "user"; text: string; at: number }
  | {
      key: string;
      kind: "assistant";
      text: string;
      /** Latest reasoning summary headline for this turn, when available. */
      summary?: string;
      /** The engine's complete raw assistant message once the turn ends
       * (pi's AgentMessage shape), for native transcript rendering. */
      message?: unknown;
      /** Streamed thinking text accumulated before the turn ends. */
      thinking?: string;
      /** True while this turn is still streaming. */
      streaming?: boolean;
      turn: number;
      at: number;
    }
  | {
      key: string;
      kind: "tool";
      label: string;
      output?: string;
      status: "running" | "ok" | "error";
      /** Raw tool identity and payloads for native transcript rendering. */
      toolName: string;
      toolCallId: string;
      args?: unknown;
      /** Raw (partial or final) tool result in pi's result shape. */
      result?: unknown;
      at: number;
    };

export interface SpawnHandle {
  readonly status: "running" | "completed" | "failed" | "aborted";
  updates: AsyncIterable<SpawnProgress>;
  /** Resolves with the outcome; rejects with AgentErrorResult, SpawnFailure,
   * or SpawnAborted. */
  wait(): Promise<SpawnOutcome>;
  /** Inject a user message into the running agent (delivered as steering when
   * the agent is mid-turn); unavailable on engines without live input. */
  prompt?(message: string): Promise<void>;
  /** Interrupt the agent's current turn (like Esc in an interactive pi
   * session) without ending the spawn; the agent stays promptable. */
  interrupt?(): Promise<void>;
  /** Keep the spawn alive across idle settles (an attached human may still
   * prompt it). Returns a release; on release an idle, resultless agent
   * settles normally. */
  hold?(): () => void;
  /** Snapshot of the live transcript; unavailable on engines without one. */
  transcript?(): readonly TranscriptItem[];
  /** Path of the engine-native pi session file, once known. Engines without
   * native sessions leave this undefined. */
  nativeSession?: Promise<string | undefined>;
  abort(): void;
}

export interface SpawnEngine {
  spawn(spec: SpawnSpec): SpawnHandle;
}
