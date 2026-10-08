/**
 * Cross-process ownership of one session's agent storage. pi-durable storage
 * has a single owner; a lock file names the owning process, and a lock whose
 * process is gone is taken over.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface StorageLock {
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(file: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Take the lock in `directory`, or return the PID of the live owner. */
export function acquireLock(
  directory: string,
): StorageLock | { owner: number } {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (readOwner(file) === process.pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(file);
      if (owner === process.pid) {
        // A previous Host of this process did not release; take it over.
        fs.rmSync(file, { force: true });
        continue;
      }
      if (owner !== undefined && processAlive(owner)) return { owner };
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not acquire ${file}`);
}
