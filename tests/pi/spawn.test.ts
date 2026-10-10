import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../../src/catalog/skills.js";
import { resolveHelper, resolveSpawn } from "../../src/pi/spawn.js";

function skill(dir: string, name: string, frontmatter = ""): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill\n${frontmatter}---\nApply ${name}.\n`,
  );
}

// User skills live in ~/.agents/skills, which tests/setup.ts points at a
// temporary home. `review` is for the user only, like a /skill: command.
const userSkills = path.join(process.env.HOME as string, ".agents", "skills");
skill(userSkills, "style");
skill(userSkills, "review", "disable-model-invocation: true\n");

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
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews\nskills: [review]\n---\nReview.\n",
  );
  return dir;
}

function context(cwd: string, trusted = true): ExtensionContext {
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
    isProjectTrusted: () => trusted,
  } as unknown as ExtensionContext;
}

describe("resolveSpawn", () => {
  test("ad-hoc agents inherit the parent model and thinking level", async () => {
    const cwd = project();
    expect(
      await resolveSpawn({ task: "x" }, context(cwd), {
        skills: discoverSkills,
        thinking: "high",
      }),
    ).toEqual({
      task: "x",
      cwd,
      ambientSkills: true,
      model: { provider: "openai", modelId: "big" },
      thinking: "high",
    });
  });

  test("profiles supply settings, instructions, and skills", async () => {
    const cwd = project();
    const spec = await resolveSpawn(
      { task: "x", profile: "checker" },
      context(cwd),
      { skills: discoverSkills, thinking: "high" },
    );
    expect(spec.model).toEqual({ provider: "openai", modelId: "mini" });
    expect(spec.thinking).toBe("low");
    expect(spec.tools).toEqual(["read"]);
    expect(spec.ambientSkills).toBe(false);
    expect(spec.instructions).toContain("Check things.");
    expect(spec.instructions).toContain("Run the linter.");
  });

  test("explicit arguments override the profile", async () => {
    const cwd = project();
    const spec = await resolveSpawn(
      {
        task: "x",
        profile: "checker",
        model: "big",
        thinking: "off",
        tools: ["read", "grep"],
      },
      context(cwd),
      { skills: discoverSkills, thinking: "high" },
    );
    expect(spec.model).toEqual({ provider: "openai", modelId: "big" });
    expect(spec.thinking).toBe("off");
    expect(spec.tools).toEqual(["read", "grep"]);
  });

  test("reports unknown profiles, skills, models, and directories", async () => {
    const cwd = project();
    expect(
      resolveSpawn({ task: "x", profile: "nope" }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow('Unknown profile "nope"');
    expect(
      resolveSpawn({ task: "x", profile: "broken" }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow("missing (unknown)");
    expect(
      resolveSpawn({ task: "x", skills: ["missing"] }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow("Unavailable skills: missing (unknown)");
    expect(
      resolveSpawn({ task: "x", model: "nope" }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow("No available model matches");
    expect(
      resolveSpawn({ task: "x", cwd: "missing" }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow("Working directory not found");
  });

  test("skills in the request replace the catalog and the profile's", async () => {
    const cwd = project();
    const chosen = await resolveSpawn(
      { task: "x", skills: ["style", "lint"] },
      context(cwd),
      { skills: discoverSkills },
    );
    expect(chosen.ambientSkills).toBe(false);
    expect(chosen.instructions).toContain("Apply style.");
    expect(chosen.instructions).toContain("Run the linter.");
    const replaced = await resolveSpawn(
      { task: "x", profile: "checker", skills: ["style"] },
      context(cwd),
      { skills: discoverSkills },
    );
    expect(replaced.instructions).toContain("Check things.");
    expect(replaced.instructions).toContain("Apply style.");
    expect(replaced.instructions).not.toContain("Run the linter.");
    // An empty list means no skills, even for a profile whose skills are
    // missing.
    const none = await resolveSpawn(
      { task: "x", profile: "broken", skills: [] },
      context(cwd),
      { skills: discoverSkills },
    );
    expect(none.ambientSkills).toBe(false);
    expect(none.instructions).toBeUndefined();
  });

  test("only profiles name skills that models can't invoke", async () => {
    const cwd = project();
    expect(
      resolveSpawn({ task: "x", skills: ["review"] }, context(cwd), {
        skills: discoverSkills,
      }),
    ).rejects.toThrow(
      "review (only the user can choose it, with /skill:review or in a profile)",
    );
    const spec = await resolveSpawn(
      { task: "x", profile: "reviewer" },
      context(cwd),
      { skills: discoverSkills },
    );
    expect(spec.instructions).toContain("Apply review.");
  });

  test("helpers choose skills like spawns", async () => {
    const cwd = project();
    const spec = await resolveHelper(
      { task: "x", skills: ["lint"] },
      context(cwd),
      { cwd },
      discoverSkills,
    );
    expect(spec.ambientSkills).toBe(false);
    expect(spec.instructions).toContain("Run the linter.");
    expect(
      resolveHelper(
        { task: "x", skills: ["review"] },
        context(cwd),
        { cwd },
        discoverSkills,
      ),
    ).rejects.toThrow("only the user can choose it");
  });
});
