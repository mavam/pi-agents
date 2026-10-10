import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { discoverSkills, SkillCatalog } from "../../src/catalog/skills.js";

function skill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\nApply ${name}.\n`,
  );
}

describe("skill discovery", () => {
  const home = process.env.HOME as string;
  const agentDir = process.env.PI_CODING_AGENT_DIR as string;
  skill(path.join(home, ".agents", "skills"), "portable");
  skill(path.join(agentDir, "skills"), "native");
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-extra-"));
  skill(extra, "configured");

  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-skills-"));
    fs.mkdirSync(path.join(dir, ".git"));
    skill(path.join(dir, ".pi", "skills"), "local");
    skill(path.join(dir, ".agents", "skills"), "shared");
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ skills: [extra] }),
    );
    return dir;
  }

  const names = async (cwd: string, trusted: boolean) =>
    (await discoverSkills(cwd, trusted)).map((skill) => skill.name).sort();

  // Other test files share the temporary home, so these check membership.
  test("finds the skills Pi finds", async () => {
    expect(await names(project(), true)).toEqual(
      expect.arrayContaining([
        "configured",
        "local",
        "native",
        "portable",
        "shared",
      ]),
    );
  });

  test("untrusted projects contribute no skills, but the user's remain", async () => {
    const found = await names(project(), false);
    expect(found).toEqual(expect.arrayContaining(["native", "portable"]));
    for (const name of ["configured", "local", "shared"])
      expect(found).not.toContain(name);
  });

  /**
   * A project with every source Pi reads: a package, settings with an
   * exclusion, a name the user defines too, and `.agents/skills` in an
   * ancestor of the cwd below the git root. Pi reads `.pi` from the cwd.
   */
  function fullProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-parity-"));
    fs.mkdirSync(path.join(root, ".git"));
    skill(path.join(root, ".agents", "skills"), "parity-ancestor");
    skill(path.join(root, "pkg", "skills"), "parity-package");
    fs.writeFileSync(
      path.join(root, "pkg", "package.json"),
      JSON.stringify({ name: "parity-pkg", version: "1.0.0" }),
    );
    const cwd = path.join(root, "sub");
    for (const name of ["parity-local", "parity-muted", "native"])
      skill(path.join(cwd, ".pi", "skills"), name);
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        packages: ["../../pkg"],
        skills: ["!**/parity-muted"],
      }),
    );
    return cwd;
  }

  /** What Pi's own resource loader finds, by name and file. */
  async function piSkills(cwd: string, trusted: boolean) {
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, {
        projectTrusted: trusted,
      }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    return loader.getSkills().skills.map((each) => [each.name, each.filePath]);
  }

  const files = async (cwd: string, trusted: boolean) =>
    (await discoverSkills(cwd, trusted)).map((each) => [
      each.name,
      each.filePath,
    ]);

  test("matches Pi's resource loader, including the winning files", async () => {
    const cwd = fullProject();
    for (const trusted of [true, false]) {
      const ours = await files(cwd, trusted);
      expect(ours).toEqual(await piSkills(cwd, trusted));
      const found = ours.map(([name]) => name);
      expect(found).not.toContain("parity-muted");
      if (trusted)
        expect(found).toEqual(
          expect.arrayContaining([
            "parity-local",
            "parity-ancestor",
            "parity-package",
          ]),
        );
      else
        for (const name of [
          "parity-local",
          "parity-ancestor",
          "parity-package",
        ])
          expect(found).not.toContain(name);
    }
    // The user's `native` loses to the project's copy only in a trusted
    // project.
    const winner = async (trusted: boolean) =>
      (await files(cwd, trusted)).find(([name]) => name === "native")?.[1];
    expect(await winner(true)).toBe(
      path.join(cwd, ".pi", "skills", "native", "SKILL.md"),
    );
    expect(await winner(false)).toBe(
      path.join(agentDir, "skills", "native", "SKILL.md"),
    );
  });

  test("the catalog shares a load in flight and retries a failed one", async () => {
    let loads = 0;
    const catalog = new SkillCatalog(async () => {
      loads += 1;
      if (loads === 1) throw new Error("boom");
      return [];
    });
    expect(catalog.get("/b", true)).rejects.toThrow("boom");
    expect(catalog.get("/b", true)).rejects.toThrow("boom");
    await Promise.resolve();
    expect(loads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await catalog.get("/b", true)).toEqual([]);
    expect(loads).toBe(2);
  });

  test("the catalog loads once per directory and trust", async () => {
    let loads = 0;
    const catalog = new SkillCatalog(async () => {
      loads += 1;
      return [];
    });
    await catalog.get("/a", true);
    await catalog.get("/a", true);
    await catalog.get("/a", false);
    expect(loads).toBe(2);
  });
});
