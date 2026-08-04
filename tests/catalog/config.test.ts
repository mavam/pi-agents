import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyBundledWorkflowsSetting,
  type BundledWorkflowPolicy,
  bundledWorkflowEnabled,
  readWorkflowConfig,
} from "../../src/catalog/config.js";

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
        '{"bundledWorkflows":{"review":true,"review-fix":false}}',
      );
      expect(readWorkflowConfig(filePath)).toEqual({
        bundledWorkflows: { review: true, "review-fix": false },
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
    expect(bundledWorkflowEnabled(projectOverride, "review-fix")).toBe(false);
  });

  test("scalar project settings reset inherited overrides", () => {
    const userPolicy = applyBundledWorkflowsSetting(defaultPolicy(), {
      review: false,
    });
    const projectPolicy = applyBundledWorkflowsSetting(userPolicy, true);

    expect(bundledWorkflowEnabled(projectPolicy, "review")).toBe(true);
    expect(bundledWorkflowEnabled(projectPolicy, "review-fix")).toBe(true);
  });
});
