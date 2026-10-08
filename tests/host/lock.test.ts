import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock } from "../../src/host/lock.js";

describe("acquireLock", () => {
  test("reports a live owner and takes over a dead one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-lock-"));
    const file = path.join(dir, "lock");
    fs.writeFileSync(file, `${process.ppid}\n`);
    expect(acquireLock(dir)).toEqual({ owner: process.ppid });
    fs.writeFileSync(file, "999999999\n");
    const lock = acquireLock(dir);
    expect("release" in lock).toBe(true);
    expect(fs.readFileSync(file, "utf-8").trim()).toBe(String(process.pid));
    if ("release" in lock) lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });
});
