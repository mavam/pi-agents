import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUNDLED_WORKFLOWS_DIR,
  parseWorkflowFile,
} from "../src/catalog/workflows.js";

const packageRoot = path.resolve(import.meta.dir, "..");

describe("npm package contents", () => {
  test("ships the internal agent result extension", () => {
    const extensionPath = path.join(
      packageRoot,
      "src",
      "engine",
      "result-tool.ts",
    );
    expect(fs.existsSync(extensionPath)).toBe(true);
  });

  test("ships the standard bundled workflow files", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as { files?: string[] };
    expect(packageJson.files).toContain(".pi/workflows");

    for (const name of ["review.yaml", "review-fix.yaml"]) {
      const filePath = path.join(BUNDLED_WORKFLOWS_DIR, name);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(typeof parseWorkflowFile(filePath, "bundled")).not.toBe("string");
    }
  });
});
