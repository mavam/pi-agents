import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyBundledWorkflowsSetting,
  type BundledWorkflowPolicy,
  bundledWorkflowEnabled,
  loadModelNotes,
  readWorkflowConfig,
  resolveModelNote,
} from "../../src/catalog/config.js";
import { userConfigFile } from "../../src/catalog/paths.js";

function defaultPolicy(): BundledWorkflowPolicy {
  return { defaultEnabled: true, overrides: new Map() };
}

describe("workflow configuration", () => {
  test("parses scalar and per-workflow settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-config-"));
    const filePath = path.join(dir, "workflows.json");
    try {
      fs.writeFileSync(filePath, '{"bundledWorkflows":false}');
      expect(readWorkflowConfig(filePath)).toEqual({ bundledWorkflows: false });

      fs.writeFileSync(
        filePath,
        '{"bundledWorkflows":{"review":true,"other":false}}',
      );
      expect(readWorkflowConfig(filePath)).toEqual({
        bundledWorkflows: { review: true, other: false },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses model guidance next to bundled workflow settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-config-"));
    const filePath = path.join(dir, "workflows.json");
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          bundledWorkflows: true,
          models: {
            "google/gemini-*-flash*": "fast triage",
            "claude-opus-*": "planning and reduces",
          },
        }),
      );
      expect(readWorkflowConfig(filePath)).toEqual({
        bundledWorkflows: true,
        models: {
          "google/gemini-*-flash*": "fast triage",
          "claude-opus-*": "planning and reduces",
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-config-"));
    const filePath = path.join(dir, "workflows.json");
    try {
      fs.writeFileSync(filePath, '{"bundledWorkflows":{"review":"no"}}');
      expect(readWorkflowConfig(filePath)).toContain(
        "must be a boolean or an object",
      );
      fs.writeFileSync(filePath, '{"models":{"gpt-*":false}}');
      expect(readWorkflowConfig(filePath)).toContain("Invalid 'models'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("layers project overrides over a disabled user default", () => {
    const globallyDisabled = applyBundledWorkflowsSetting(
      defaultPolicy(),
      false,
    );
    const projectOverride = applyBundledWorkflowsSetting(globallyDisabled, {
      review: true,
    });

    expect(bundledWorkflowEnabled(projectOverride, "review")).toBe(true);
    expect(bundledWorkflowEnabled(projectOverride, "other")).toBe(false);
  });

  test("loads trusted project notes, clamps untrusted projects, and honors glob precedence", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-model-config-"),
    );
    const projectPi = path.join(project, ".pi");
    fs.mkdirSync(projectPi, { recursive: true });
    const userFile = userConfigFile();
    const previous = fs.existsSync(userFile)
      ? fs.readFileSync(userFile, "utf8")
      : undefined;
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    try {
      fs.writeFileSync(
        userFile,
        JSON.stringify({
          models: {
            "claude-*": "user family",
            "anthropic/claude-opus-*": "user specific",
            "openai/gpt-*": "user tie",
          },
        }),
      );
      fs.writeFileSync(
        path.join(projectPi, "workflows.json"),
        JSON.stringify({
          models: {
            "anthropic/claude-*": "project family",
            "openai/gpt-*": "project tie",
          },
        }),
      );

      const trusted = loadModelNotes(project, true);
      expect(resolveModelNote(trusted, "anthropic/claude-opus-4-6")).toBe(
        "user specific",
      );
      expect(resolveModelNote(trusted, "openai/gpt-5")).toBe("project tie");
      expect(resolveModelNote(trusted, "xai/claude-sonnet-4")).toBe(
        "user family",
      );
      expect(
        resolveModelNote(trusted, "anthropic/claude?-opus-4"),
      ).toBeUndefined();

      const untrusted = loadModelNotes(project, false);
      expect(resolveModelNote(untrusted, "openai/gpt-5")).toBe("user tie");
      expect(untrusted.every((rule) => rule.scope === "user")).toBe(true);
    } finally {
      if (previous === undefined) fs.rmSync(userFile, { force: true });
      else fs.writeFileSync(userFile, previous);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test("scalar project settings reset inherited overrides", () => {
    const userPolicy = applyBundledWorkflowsSetting(defaultPolicy(), {
      review: false,
    });
    const projectPolicy = applyBundledWorkflowsSetting(userPolicy, true);

    expect(bundledWorkflowEnabled(projectPolicy, "review")).toBe(true);
    expect(bundledWorkflowEnabled(projectPolicy, "other")).toBe(true);
  });
});
