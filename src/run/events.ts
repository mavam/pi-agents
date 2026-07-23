/**
 * Run-event schema v3. Runs are event-sourced: everything the UI and history
 * need is reconstructable by replaying these events. Nodes are addressed by
 * static `path` (position in the flow tree) plus dynamic `instance` (the path
 * with `@item` / `#iteration` suffixes interleaved for dynamic multiplicity).
 */

import type { SpawnUsage } from "../engine/types.js";
import type { Budgets, FlowNode, NodeKind, Scope } from "../model/ast.js";

export const RUN_EVENT_TYPE = "pi-agents:run-event:v3";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type NodeStatus = "running" | "completed" | "failed" | "cancelled";

export type CancelReason = "any" | "quorum" | "sibling_failed" | "stopped";

export type SteeringSource = "user" | "tool" | "rpc";

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
      agent?: string;
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
      type: "node_steered";
      at: number;
      runId: string;
      path: string;
      instance: string;
      message: string;
      source: SteeringSource;
      /** Self-declared extension name for cross-extension RPC steering. */
      caller?: string;
    }
  | {
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
