import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSpawn } from "../../src/pi/spawn.js";

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-spawn-"));
  fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "skills", "lint"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".pi", "skills", "lint", "SKILL.md"),
    "---\nname: lint\ndescription: Lint code\n---\nRun the linter.\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "checker.md"),
    "---\nname: checker\ndescription: Checks\nmodel: openai/mini\nthinking: low\ntools: [read]\nskills: [lint]\n---\nCheck things.\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "broken.md"),
    "---\nname: broken\ndescription: Broken\nskills: [missing]\n---\n",
  );
  return dir;
}

function context(cwd: string): ExtensionContext {
  const models = [
    {
      provider: "openai",
      id: "mini",
      cost: { input: 1, output: 1 },
      contextWindow: 1,
    },
    {
      provider: "openai",
      id: "big",
      cost: { input: 1, output: 1 },
      contextWindow: 1,
    },
  ];
  return {
    cwd,
    model: { provider: "openai", id: "big" },
    modelRegistry: { getAvailable: () => models, isUsingOAuth: () => false },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

describe("resolveSpawn", () => {
  test("ad-hoc agents inherit the parent model and thinking level", () => {
    const cwd = project();
    expect(resolveSpawn({ task: "x" }, context(cwd), "high")).toEqual({
      task: "x",
      cwd,
      ambientSkills: true,
      model: { provider: "openai", modelId: "big" },
      thinking: "high",
    });
  });

  test("profiles supply settings, instructions, and skills", () => {
    const cwd = project();
    const spec = resolveSpawn(
      { task: "x", profile: "checker" },
      context(cwd),
      "high",
    );
    expect(spec.model).toEqual({ provider: "openai", modelId: "mini" });
    expect(spec.thinking).toBe("low");
    expect(spec.tools).toEqual(["read"]);
    expect(spec.ambientSkills).toBe(false);
    expect(spec.instructions).toContain("Check things.");
    expect(spec.instructions).toContain("Run the linter.");
  });

  test("explicit arguments override the profile", () => {
    const cwd = project();
    const spec = resolveSpawn(
      {
        task: "x",
        profile: "checker",
        model: "big",
        thinking: "off",
        tools: ["read", "grep"],
      },
      context(cwd),
      "high",
    );
    expect(spec.model).toEqual({ provider: "openai", modelId: "big" });
    expect(spec.thinking).toBe("off");
    expect(spec.tools).toEqual(["read", "grep"]);
  });

  test("reports unknown profiles, skills, models, and directories", () => {
    const cwd = project();
    expect(() =>
      resolveSpawn({ task: "x", profile: "nope" }, context(cwd), undefined),
    ).toThrow('Unknown profile "nope"');
    expect(() =>
      resolveSpawn({ task: "x", profile: "broken" }, context(cwd), undefined),
    ).toThrow("missing (unknown)");
    expect(() =>
      resolveSpawn({ task: "x", model: "nope" }, context(cwd), undefined),
    ).toThrow("unknown model 'nope'");
    expect(() =>
      resolveSpawn({ task: "x", cwd: "missing" }, context(cwd), undefined),
    ).toThrow("Working directory not found");
  });
});
