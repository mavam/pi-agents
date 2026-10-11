import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneSessions, readRetention } from "../../src/host/retention.js";

test("the retention comes from piAgents.retentionDays", () => {
  expect(readRetention({})).toEqual({});
  expect(readRetention({ piAgents: { retentionDays: 30 } })).toEqual({
    days: 30,
  });
  for (const value of [0, -1, 1.5, "30"]) {
    const { days, error } = readRetention({
      piAgents: { retentionDays: value },
    });
    expect(days).toBeUndefined();
    expect(error).toContain("positive integer");
  }
});

test("pruning deletes old sessions but keeps fresh, current, and held ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-retention-"));
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const session = (name: string, age: Date, lock?: number) => {
    const directory = path.join(root, name);
    const storage = path.join(directory, "storage");
    fs.mkdirSync(storage, { recursive: true });
    const file = path.join(storage, "events.jsonl");
    fs.writeFileSync(file, "{}\n");
    if (lock !== undefined)
      fs.writeFileSync(path.join(directory, "lock"), `${lock}\n`);
    fs.utimesSync(file, age, age);
    fs.utimesSync(directory, age, age);
  };
  session("old", old);
  session("abandoned", old, 999999999);
  session("current", old);
  session("held", old, process.ppid);
  session("fresh", new Date());
  // A recent write to storage keeps a session whose directory looks old.
  session("written", old);
  fs.writeFileSync(path.join(root, "written", "storage", "events.jsonl"), "");

  const errors: Error[] = [];
  const deleted = await pruneSessions({
    root,
    days: 30,
    current: "current",
    onError: (error) => errors.push(error),
  });
  expect(deleted.sort()).toEqual(["abandoned", "old"]);
  expect(fs.readdirSync(root).sort()).toEqual([
    "current",
    "fresh",
    "held",
    "written",
  ]);
  expect(errors).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});
