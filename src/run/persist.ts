/**
 * Run-event persistence.
 *
 * Events are written to a sidecar JSONL file next to the origin session file
 * (`<session>.pi-agents.jsonl`), never into the session file itself. Pi
 * treats the last line of a session file as the active leaf on reload, so a
 * backgrounded run appending entries there would silently fork the session
 * tree and drop conversation tail entries off the active branch. The sidecar
 * cannot corrupt the session, survives reloads, and works identically for
 * foreground, backgrounded, and cross-session runs.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../protocol.js";
import type { RunEvent } from "./events.js";

export interface RunEventOrigin {
  sessionFile?: string;
}

interface PersistedRunEvent {
  protocol: typeof PROTOCOL_VERSION;
  event: RunEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NODE_KINDS = new Set([
  "agent",
  "sequence",
  "parallel",
  "map",
  "loop",
  "while",
  "switch",
  "value",
  "workflow",
  "reduce",
]);
const CANCEL_REASONS = new Set([
  "any",
  "quorum",
  "sibling_failed",
  "stopped",
  "budget",
]);
const FINAL_RUN_STATUSES = new Set(["completed", "failed", "stopped"]);

/** Reject corrupt or foreign records before they reach the state reducer. */
function isRunEvent(value: unknown): value is RunEvent {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.at !== "number"
  ) {
    return false;
  }
  if (value.type === "run_created") {
    return (
      isRecord(value.run) &&
      typeof value.run.id === "string" &&
      isRecord(value.run.source) &&
      isRecord(value.run.flow) &&
      typeof value.run.depth === "number"
    );
  }
  if (typeof value.runId !== "string") return false;
  switch (value.type) {
    case "node_started":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.kind === "string" &&
        NODE_KINDS.has(value.kind) &&
        (value.profile === undefined || typeof value.profile === "string") &&
        (value.label === undefined || typeof value.label === "string") &&
        (value.model === undefined || typeof value.model === "string") &&
        (value.requestedModel === undefined ||
          typeof value.requestedModel === "string") &&
        (value.thinking === undefined || typeof value.thinking === "string")
      );
    case "node_model":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.model === "string"
      );
    case "node_completed":
      return typeof value.instance === "string";
    case "node_failed":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.error === "string"
      );
    case "node_cancelled":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.reason === "string" &&
        CANCEL_REASONS.has(value.reason)
      );
    case "node_session":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.sessionFile === "string"
      );
    case "loop_iteration":
      return (
        typeof value.path === "string" &&
        typeof value.instance === "string" &&
        typeof value.iteration === "number"
      );
    case "run_backgrounded":
      return true;
    case "run_completed":
      return (
        typeof value.status === "string" &&
        FINAL_RUN_STATUSES.has(value.status) &&
        isRecord(value.usage) &&
        typeof value.agents === "number"
      );
    default:
      return false;
  }
}

export function sidecarPath(sessionFile: string): string {
  return `${sessionFile}.pi-agents.jsonl`;
}

export function createOrigin(
  ctx: Pick<ExtensionContext, "sessionManager">,
): RunEventOrigin {
  return { sessionFile: getSessionFile(ctx as ExtensionContext) };
}

/** Append one event to the origin's sidecar. False when no session file is known. */
export function appendRunEvent(
  origin: RunEventOrigin,
  event: RunEvent,
): boolean {
  if (!origin.sessionFile) return false;
  // Events persist uncropped: node and run values are the only artifact of
  // an agent's work, so the sidecar is the source of truth across restarts.
  const record: PersistedRunEvent = {
    protocol: PROTOCOL_VERSION,
    event,
  };
  appendFileSync(
    sidecarPath(origin.sessionFile),
    `${JSON.stringify(record)}\n`,
    "utf-8",
  );
  return true;
}

/** Read all persisted run events for a session file. */
export function readRunEvents(sessionFile: string | undefined): RunEvent[] {
  if (!sessionFile) return [];
  const path = sidecarPath(sessionFile);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const events: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (
        !isRecord(record) ||
        record.protocol !== PROTOCOL_VERSION ||
        !isRunEvent(record.event)
      ) {
        continue;
      }
      events.push(record.event);
    } catch {
      // Skip corrupt lines; persistence is best-effort.
    }
  }
  return events;
}

/** Build the per-run persister. Persistence errors never break a live run. */
export function createPersister(
  origin: RunEventOrigin,
): (event: RunEvent) => void {
  return (event) => {
    try {
      appendRunEvent(origin, event);
    } catch {
      // best-effort
    }
  };
}

export function getSessionFile(
  ctx: ExtensionContext | undefined,
): string | undefined {
  if (!ctx) return undefined;
  return typeof ctx.sessionManager?.getSessionFile === "function"
    ? ctx.sessionManager.getSessionFile()
    : undefined;
}

export function isIdle(ctx: ExtensionContext | undefined): boolean {
  return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
}

/** Project trust for this context (pi >= 0.80). Absent method means trusted. */
export function isProjectTrusted(ctx: ExtensionContext | undefined): boolean {
  return typeof ctx?.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : true;
}
