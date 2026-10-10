import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
