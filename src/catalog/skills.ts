/**
 * The skills agents can use, found the way Pi finds them at startup.
 *
 * Pi's package manager resolves the skill locations: `~/.pi/agent/skills`
 * and `~/.agents/skills`, the project's `.pi/skills` and `.agents/skills`,
 * packages, and the `skills` setting with its overrides. An untrusted
 * project contributes nothing, but the user's skills stay available.
 * Resolution never installs a missing package; it skips it.
 *
 * Only resources on disk count. What exists only in the running session,
 * such as `--skill` paths, `-e` packages, skills that extensions add, and
 * `--no-skills`, doesn't reach agents.
 *
 * Agents see these skills as a catalog, like the parent session, or get a
 * chosen few inlined. Only the user chooses skills marked
 * `disable-model-invocation`: through `/skill:` in Pi, or in a profile.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  type ResolvedResource,
  SettingsManager,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

/** The skills available in a directory, under the given project trust. */
export type SkillSource = (cwd: string, trusted: boolean) => Promise<Skill[]>;

/** A directory skill resolves to its `SKILL.md`, as in Pi's resource loader. */
function skillPath(resource: ResolvedResource): string {
  if (
    resource.metadata.source !== "auto" &&
    resource.metadata.origin !== "package"
  )
    return resource.path;
  const file = path.join(resource.path, "SKILL.md");
  try {
    if (fs.statSync(resource.path).isDirectory() && fs.existsSync(file))
      return file;
  } catch {}
  return resource.path;
}

/** Pi's skills for a directory, read from disk now. */
export const discoverSkills: SkillSource = async (cwd, trusted) => {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: trusted,
  });
  const packages = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  const resolved = await packages.resolve(async () => "skip");
  const skillPaths = resolved.skills
    .filter((resource) => resource.enabled)
    .map(skillPath);
  return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false })
    .skills;
};

/**
 * Skills loaded once per directory and trust, like Pi at startup; Pi's
 * `/reload` starts a fresh catalog.
 */
export class SkillCatalog {
  private readonly cache = new Map<string, Promise<Skill[]>>();

  constructor(private readonly source: SkillSource = discoverSkills) {}

  readonly get: SkillSource = (cwd, trusted) => {
    const key = `${trusted}:${path.resolve(cwd)}`;
    let found = this.cache.get(key);
    if (found === undefined) {
      found = this.source(cwd, trusted);
      this.cache.set(key, found);
      // A failed load is retried next time.
      found.catch(() => this.cache.delete(key));
    }
    return found;
  };
}

/** Who names the skills: the user in a profile, or a model in a tool call. */
export type Chooser = "user" | "model";

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The named skills as one prompt block, plus the names that could not be
 * delivered. A missing skill is a configuration error, never a silently
 * degraded prompt.
 */
export function inlineSkills(
  names: readonly string[],
  available: readonly Skill[],
  chooser: Chooser,
): { prompt: string; missing: string[] } {
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(names.map((name) => name.trim()))) {
    if (!name) continue;
    const skill = byName.get(name);
    if (!skill) {
      missing.push(`${name} (unknown)`);
      continue;
    }
    if (chooser === "model" && skill.disableModelInvocation) {
      missing.push(
        `${name} (only the user can choose it, with /skill:${name} or in a profile)`,
      );
      continue;
    }
    let body: string;
    try {
      body = stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8")).trim();
    } catch (error) {
      missing.push(
        `${name} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    blocks.push(
      `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
    );
  }
  const prompt =
    blocks.length === 0
      ? ""
      : ["Apply the following skills when working on this task:", "", ...blocks]
          .join("\n")
          .trim();
  return { prompt, missing };
}
