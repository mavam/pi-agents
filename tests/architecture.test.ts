/**
 * Structural drift checks for the launch contract (docs/plans/launch-contract.md).
 *
 * Trigger surfaces parse surface input and format surface output; the launch
 * layer (src/run/launch.ts) owns validation and saved-workflow resolution for
 * execution. Catalog reads for routing or listing (hook event filtering,
 * /workflows listings) remain legitimate in triggers.
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

  test("triggers do not normalize display paths themselves", () => {
    for (const { file, text } of triggerSources()) {
      expect(
        text.includes("normalizeDisplayPath"),
        `${file} normalizes display paths; go through run/launch.ts`,
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
});
