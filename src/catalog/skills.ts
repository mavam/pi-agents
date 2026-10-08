/**
 * Skills a profile names, inlined into the agent's instructions.
 *
 * Discovery mirrors the locations and precedence Pi advertises in
 * `<available_skills>`: `.pi/skills` and `.agents/skills` for the project,
 * then `~/.pi/agent/skills` and `~/.agents/skills` for the user, with the
 * first definition of a name winning. Scope selects which directories apply,
 * so an untrusted project (user scope) never contributes a skill.
 */

import * as fs from "node:fs";
import {
  loadSkillsFromDir,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { projectSkillDirs, userSkillDirs } from "./paths.js";
import type { Scope, Source } from "./profiles.js";

function discoverSkills(cwd: string, scope: Scope): Map<string, Skill> {
  const dirs: Array<[string, Source]> = [];
  if (scope !== "user")
    for (const dir of projectSkillDirs(cwd)) dirs.push([dir, "project"]);
  if (scope !== "project")
    for (const dir of userSkillDirs()) dirs.push([dir, "user"]);
  const skills = new Map<string, Skill>();
  for (const [dir, source] of dirs)
    for (const skill of loadSkillsFromDir({ dir, source }).skills)
      if (!skills.has(skill.name)) skills.set(skill.name, skill);
  return skills;
}

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
export function loadSkills(
  names: readonly string[],
  cwd: string,
  scope: Scope,
): { prompt: string; missing: string[] } {
  const available = discoverSkills(cwd, scope);
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(names.map((name) => name.trim()))) {
    if (!name) continue;
    const skill = available.get(name);
    if (!skill) {
      missing.push(`${name} (unknown)`);
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
