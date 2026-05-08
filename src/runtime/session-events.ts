import { appendFileSync } from "node:fs";
import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { RUN_EVENT_CUSTOM_TYPE } from "./persistence.js";
import type { RunEvent } from "./types.js";

type SessionLocator = {
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
};

export interface RunEventOrigin {
  parentId: string | null;
  sessionFile?: string;
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
    customType: RUN_EVENT_CUSTOM_TYPE,
    data: event,
  };
}

function isSessionLocator(value: unknown): value is SessionLocator {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionLocator).getLeafId === "function" &&
    typeof (value as SessionLocator).getSessionFile === "function"
  );
}

export class RunEventCache {
  private readonly entriesBySessionFile = new Map<
    string,
    CustomEntry<RunEvent>[]
  >();

  createOrigin(sessionManager: unknown): RunEventOrigin {
    if (!isSessionLocator(sessionManager)) {
      return { parentId: null };
    }

    return {
      parentId: sessionManager.getLeafId(),
      sessionFile: sessionManager.getSessionFile(),
    };
  }

  appendToOrigin(origin: RunEventOrigin, event: RunEvent): boolean {
    if (!origin.sessionFile) {
      return false;
    }

    const entry = createRunEventEntry(event, origin.parentId);
    origin.parentId = entry.id;

    const cached = this.entriesBySessionFile.get(origin.sessionFile);
    if (cached) cached.push(entry);
    else this.entriesBySessionFile.set(origin.sessionFile, [entry]);

    appendFileSync(origin.sessionFile, `${JSON.stringify(entry)}\n`, "utf-8");
    return true;
  }

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
