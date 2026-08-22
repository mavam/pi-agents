/**
 * Run events are the source of truth for live state, persisted history, and
 * external observers. Nodes use a static flow `path` plus a dynamic `instance`
 * that includes map-item and loop-iteration suffixes.
 */

import type { SpawnUsage } from "../engine/types.js";
import type { Budgets, FlowNode, NodeKind, Scope } from "../model/ast.js";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type NodeStatus = "running" | "completed" | "failed" | "cancelled";

export type CancelReason =
  | "any"
  | "quorum"
  | "sibling_failed"
  | "stopped"
  | "budget";

export interface RunSource {
  kind: "tool" | "command" | "hook" | "rpc";
  /** Saved workflow name, when the run came from one. */
  workflow?: string;
  /** Triggering pi event name, for hook runs. */
  event?: string;
  /** Self-declared calling extension, for RPC runs. */
  caller?: string;
}

export interface RunHeader {
  id: string;
  label?: string;
  /** Saved-workflow result path selected for human-facing rendering. */
  display?: string;
  /** Recoverable request problems that did not prevent this run. */
  warnings?: string[];
  source: RunSource;
  /** The expanded flow (workflow refs inlined). */
  flow: FlowNode;
  params?: Record<string, unknown>;
  budgets?: Budgets;
  cwd?: string;
  scope?: Scope;
  originSessionFile?: string;
  /** Cross-process delegation depth this run started at. */
  depth: number;
}

export type RunEvent =
  | { type: "run_created"; at: number; run: RunHeader }
  | {
      type: "node_started";
      at: number;
      runId: string;
      path: string;
      instance: string;
      kind: NodeKind | "reduce";
      profile?: string;
      label?: string;
    }
  | {
      type: "node_completed";
      at: number;
      runId: string;
      path: string;
      instance: string;
      value?: unknown;
      usage?: SpawnUsage;
    }
  | {
      type: "node_failed";
      at: number;
      runId: string;
      path: string;
      instance: string;
      error: string;
      /** Last streamed output of a budget-cut agent, preserved as the
       * partial result. */
      partialText?: string;
    }
  | {
      type: "node_cancelled";
      at: number;
      runId: string;
      path: string;
      instance: string;
      reason: CancelReason;
    }
  | {
      /** The delegated agent's own pi session file became known. Persisted,
       * so finished agents remain attachable across restarts. */
      type: "node_session";
      at: number;
      runId: string;
      path: string;
      instance: string;
      sessionFile: string;
    }
  | {
      /** Emitted before a loop or while body iteration starts. */
      type: "loop_iteration";
      at: number;
      runId: string;
      path: string;
      instance: string;
      iteration: number;
    }
  | { type: "run_backgrounded"; at: number; runId: string }
  | {
      type: "run_completed";
      at: number;
      runId: string;
      status: Exclude<RunStatus, "running">;
      value?: unknown;
      error?: string;
      usage: SpawnUsage;
      /** Total agent spawns consumed. */
      agents: number;
    };
