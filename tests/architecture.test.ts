/**
 * Structural drift checks for the launch contract (docs/plans/launch-contract.md).
 *
 * Trigger surfaces parse and format. Only the trigger launch adapter may
 * prepare a fresh request or start a manager run. Catalog reads for routing,
 * listing, and previews remain legitimate in triggers.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TRIGGERS_DIR = path.join(import.meta.dir, "..", "src", "triggers");

function triggerSources(): Array<{ file: string; text: string }> {
  return readdirSync(TRIGGERS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: `src/triggers/${name}`,
      text: readFileSync(path.join(TRIGGERS_DIR, name), "utf8"),
    }));
}

describe("architecture invariants", () => {
  test("triggers do not validate flows themselves", () => {
    for (const { file, text } of triggerSources()) {
      expect(
        text.includes("model/validate"),
        `${file} imports validateFlow; go through run/launch.ts`,
      ).toBe(false);
    }
  });

  test("only the trigger launch adapter prepares or starts fresh runs", () => {
    for (const { file, text } of triggerSources()) {
      if (file === "src/triggers/start.ts") continue;
      expect(
        text.includes("prepareLaunch"),
        `${file} prepares a launch; use launchTriggeredRun`,
      ).toBe(false);
      expect(
        text.includes("manager.start("),
        `${file} starts the manager directly; use launchTriggeredRun`,
      ).toBe(false);
    }
  });

  test("triggers do not normalize display paths themselves", () => {
    for (const { file, text } of triggerSources()) {
      expect(
        text.includes("normalizeDisplayPath"),
        `${file} normalizes display paths; use launchTriggeredRun`,
      ).toBe(false);
    }
  });

  test("the model layer carries no presentation logic", () => {
    const modelDir = path.join(import.meta.dir, "..", "src", "model");
    for (const name of readdirSync(modelDir)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(path.join(modelDir, name), "utf8");
      expect(
        text.includes("normalizeDisplayPath"),
        `src/model/${name} contains display handling`,
      ).toBe(false);
      expect(
        text.includes("../ui/"),
        `src/model/${name} imports from ui/`,
      ).toBe(false);
    }
  });

  test("catalog and run layers do not depend on the TUI layer", () => {
    for (const directory of ["catalog", "run"]) {
      const sourceDir = path.join(import.meta.dir, "..", "src", directory);
      for (const name of readdirSync(sourceDir)) {
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(path.join(sourceDir, name), "utf8");
        expect(
          text.includes("../ui/"),
          `src/${directory}/${name} imports from ui/`,
        ).toBe(false);
      }
    }
  });

  test("presentation policy does not depend on runtime or TUI modules", () => {
    const sourceDir = path.join(import.meta.dir, "..", "src", "presentation");
    for (const name of readdirSync(sourceDir)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(path.join(sourceDir, name), "utf8");
      expect(
        text.includes("../run/"),
        `src/presentation/${name} imports from run/; inject runtime policy`,
      ).toBe(false);
      expect(
        text.includes("../ui/"),
        `src/presentation/${name} imports from ui/`,
      ).toBe(false);
      expect(
        text.includes("@earendil-works/pi-"),
        `src/presentation/${name} depends on Pi`,
      ).toBe(false);
    }
  });
});
