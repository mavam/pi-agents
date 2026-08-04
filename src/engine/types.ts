/**
 * Spawn engine abstraction: runs one delegated agent as an isolated process
 * and streams its progress. The subprocess implementation lives in
 * subprocess.ts; tests inject fakes.
 */

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

export type ResultMode = "text" | "json";

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
  /** Required schema for the delegated agent's submitted result. */
  resultMode: ResultMode;
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
}

export interface SpawnProgress {
  /** Latest assistant text so far. */
  text: string;
  /** Bounded, chronological activity tail for live observation. Engines may
   * omit this when they only support latest-text progress. */
  tail?: string;
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

/** Thrown by wait() when the spawn was aborted via abort(). */
export class SpawnAborted extends Error {
  constructor(agent: string) {
    super(`Agent ${agent} aborted.`);
    this.name = "SpawnAborted";
  }
}

export interface SpawnHandle {
  readonly status: "running" | "completed" | "failed" | "aborted";
  updates: AsyncIterable<SpawnProgress>;
  /** Resolves with the outcome; rejects with SpawnFailure or SpawnAborted. */
  wait(): Promise<SpawnOutcome>;
  /** Queue a steering message; unavailable on engines without live input. */
  steer?(message: string): Promise<void>;
  abort(): void;
}

export interface SpawnEngine {
  spawn(spec: SpawnSpec): SpawnHandle;
}
