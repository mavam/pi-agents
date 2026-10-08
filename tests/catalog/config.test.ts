import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadModelNotes,
  readConfig,
  resolveModelNote,
} from "../../src/catalog/config.js";
import { userConfigFile } from "../../src/catalog/paths.js";

describe("configuration", () => {
  test("reads model notes and rejects unknown keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-config-"));
    const file = path.join(dir, "pi-agents.json");
    fs.writeFileSync(file, '{"models":{"openai/*":"fast"}}');
    expect(readConfig(file)).toEqual({ models: { "openai/*": "fast" } });
    fs.writeFileSync(file, '{"bundledWorkflows":true}');
    expect(readConfig(file)).toContain("Unsupported keys: bundledWorkflows");
    fs.writeFileSync(file, "{nope");
    expect(readConfig(file)).toContain("Could not parse JSON");
    expect(readConfig(path.join(dir, "missing.json"))).toBeUndefined();
  });

  test("prefers specific patterns and project scope", () => {
    fs.writeFileSync(
      userConfigFile(),
      JSON.stringify({
        models: { "openai/*": "user", "openai/gpt-5": "exact" },
      }),
    );
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-project-"),
    );
    fs.mkdirSync(path.join(project, ".pi"));
    fs.writeFileSync(
      path.join(project, ".pi", "pi-agents.json"),
      JSON.stringify({ models: { "openai/*": "project" } }),
    );
    const notes = loadModelNotes(project, true);
    expect(resolveModelNote(notes, "openai/gpt-4")).toBe("project");
    expect(resolveModelNote(notes, "openai/gpt-5")).toBe("exact");
    expect(
      resolveModelNote(loadModelNotes(project, false), "openai/gpt-4"),
    ).toBe("user");
    fs.rmSync(userConfigFile());
  });
});
