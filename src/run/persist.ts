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
import { type RunEvent, truncateEventForPersistence } from "./events.js";

export interface RunEventOrigin {
  sessionFile?: string;
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
  const entry = truncateEventForPersistence(event);
  appendFileSync(
    sidecarPath(origin.sessionFile),
    `${JSON.stringify(entry)}\n`,
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
      events.push(JSON.parse(line) as RunEvent);
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
