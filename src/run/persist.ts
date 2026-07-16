/**
 * Run-event persistence into pi session files.
 *
 * Two paths: while the originating session is current, events could go
 * through pi.appendEntry; but a backgrounded run keeps emitting after the
 * tool call returned or the user switched sessions, so events are written
 * directly to the origin session file as CustomEntry JSONL lines with a
 * linked parentId chain. An in-memory cache lets a rebuild in the same
 * process see entries that pi has not re-read from disk yet.
 */

import { appendFileSync } from "node:fs";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  RUN_EVENT_TYPE,
  type RunEvent,
  truncateEventForPersistence,
} from "./events.js";

export interface RunEventOrigin {
  parentId: string | null;
  sessionFile?: string;
}

interface SessionLocator {
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
}

function isSessionLocator(value: unknown): value is SessionLocator {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionLocator).getLeafId === "function" &&
    typeof (value as SessionLocator).getSessionFile === "function"
  );
}

function createRunEventEntry(
  event: RunEvent,
  parentId: string | null,
): CustomEntry<RunEvent> {
  return {
    type: "custom",
    id: crypto.randomUUID().slice(0, 8),
    parentId,
    timestamp: new Date().toISOString(),
    customType: RUN_EVENT_TYPE,
    data: event,
  };
}

export function isRunEventEntry(
  entry: SessionEntry,
): entry is CustomEntry<RunEvent> {
  return (
    entry.type === "custom" &&
    entry.customType === RUN_EVENT_TYPE &&
    (entry as CustomEntry<RunEvent>).data !== undefined
  );
}

export function extractRunEvents(entries: SessionEntry[]): RunEvent[] {
  const events: RunEvent[] = [];
  for (const entry of entries) {
    if (isRunEventEntry(entry) && entry.data) events.push(entry.data);
  }
  return events;
}

export class RunEventCache {
  private readonly entriesBySessionFile = new Map<
    string,
    CustomEntry<RunEvent>[]
  >();

  createOrigin(sessionManager: unknown): RunEventOrigin {
    if (!isSessionLocator(sessionManager)) return { parentId: null };
    return {
      parentId: sessionManager.getLeafId(),
      sessionFile: sessionManager.getSessionFile(),
    };
  }

  /** Append directly to the origin session file. False when no file is known. */
  appendToOrigin(origin: RunEventOrigin, event: RunEvent): boolean {
    if (!origin.sessionFile) return false;
    const entry = createRunEventEntry(event, origin.parentId);
    origin.parentId = entry.id;
    const cached = this.entriesBySessionFile.get(origin.sessionFile);
    if (cached) cached.push(entry);
    else this.entriesBySessionFile.set(origin.sessionFile, [entry]);
    appendFileSync(origin.sessionFile, `${JSON.stringify(entry)}\n`, "utf-8");
    return true;
  }

  /** Merge cached entries pi has not re-read from disk into a rebuild. */
  mergeEntries(
    sessionFile: string | undefined,
    entries: SessionEntry[],
  ): SessionEntry[] {
    if (!sessionFile) return entries;
    const cached = this.entriesBySessionFile.get(sessionFile);
    if (!cached || cached.length === 0) return entries;
    const known = new Set(entries.map((entry) => entry.id));
    const merged = [...entries];
    for (const entry of cached) {
      if (known.has(entry.id)) continue;
      merged.push(entry);
    }
    return merged;
  }
}

/** Build the per-run persister: origin-file append with pi.appendEntry fallback. */
export function createPersister(
  pi: ExtensionAPI,
  cache: RunEventCache,
  origin: RunEventOrigin,
): (event: RunEvent) => void {
  return (event) => {
    const truncated = truncateEventForPersistence(event);
    try {
      if (!cache.appendToOrigin(origin, truncated)) {
        pi.appendEntry(RUN_EVENT_TYPE, truncated);
      }
    } catch {
      // Persistence is best-effort; never let it break a live run.
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
