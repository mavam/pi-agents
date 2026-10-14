/**
 * Retention of agent storage. Every persistent Pi session gets its own
 * directory under `~/.pi/agent/pi-agents/sessions/`, and Pi deleting its
 * session file leaves it behind. With `piAgents.retentionDays`, the host
 * deletes directories that saw no write for that many days, once per Pi
 * start. Directories of the current session and of sessions another live
 * process holds stay.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { lockHolder } from "./lock.js";
import { readPositiveInteger } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention from Pi's merged settings: `piAgents.retentionDays`. Absent
 * means keep everything; anything but a positive integer is an error, and
 * pi-agents then keeps everything.
 */
export function readRetention(settings: unknown): {
  days?: number;
  error?: string;
} {
  const { value, error } = readPositiveInteger(settings, "retentionDays");
  return error ? { error } : value === undefined ? {} : { days: value };
}

/** The newest mtime of `directory` and the files directly in its `storage/`. */
async function lastWrite(directory: string): Promise<number> {
  let newest = (await fs.stat(directory)).mtimeMs;
  const storage = path.join(directory, "storage");
  let names: string[];
  try {
    names = await fs.readdir(storage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return newest;
    throw error;
  }
  for (const name of names) {
    try {
      const stat = await fs.stat(path.join(storage, name));
      if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return newest;
}

/**
 * Delete the session directories in `root` whose last write is older than
 * `days` days, except `current` and those whose lock a live process holds.
 * A failure for one directory goes to `onError` and doesn't stop the
 * others; one already gone is skipped. Stops early once
 * `stopped` returns true. Returns the names of the deleted directories.
 */
export async function pruneSessions(options: {
  root: string;
  days: number;
  current?: string;
  now?: number;
  stopped?: () => boolean;
  onError?: (error: Error) => void;
}): Promise<string[]> {
  const { root, days, current } = options;
  const cutoff = (options.now ?? Date.now()) - days * DAY_MS;
  const report = (error: unknown) =>
    options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
    return [];
  }
  const deleted: string[] = [];
  for (const entry of entries) {
    if (options.stopped?.()) break;
    if (!entry.isDirectory() || entry.name === current) continue;
    const directory = path.join(root, entry.name);
    try {
      if ((await lastWrite(directory)) >= cutoff) continue;
      if (lockHolder(directory) !== undefined) continue;
      await fs.rm(directory, { recursive: true, force: true });
      deleted.push(entry.name);
    } catch (error) {
      // Another process pruned it first.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      report(
        new Error(
          `Could not delete old agent storage ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return deleted;
}
