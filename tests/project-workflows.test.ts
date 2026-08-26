import { describe, expect, test } from "bun:test";
import path from "node:path";
import { discoverWorkflows } from "../src/catalog/workflows.js";
import {
  collectInvocations,
  collectProfileNames,
} from "../src/model/validate.js";

const projectDir = path.resolve(import.meta.dir, "..");

describe("project review workflow", () => {
  test("discovers without diagnostics or external profiles and skills", () => {
    const discovery = discoverWorkflows(projectDir, "project");
    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.workflows.map((workflow) => workflow.name)).toEqual([
      "review",
    ]);

    const review = discovery.workflows[0];
    if (!review) throw new Error("missing bundled review workflow");
    expect(review.display).toBe("report");
    expect([...collectProfileNames(review.flow)]).toEqual([]);
    for (const invocation of collectInvocations(review.flow)) {
      expect(invocation.skills).toEqual([]);
    }
  });
});
