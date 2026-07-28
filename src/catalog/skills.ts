/**
 * Skill discovery, name resolution, and prompt rendering — three separate
 * jobs, deliberately not fused.
 *
 * Discovery lists what a (cwd, scope) pair offers and reads no bodies.
 * Resolution turns requested names into self-contained `ResolvedSkill` values,
 * reading and stripping only the files actually asked for, and reports every
 * failure instead of degrading. Rendering is pure: it performs no I/O, so a
 * skill that resolves during preflight cannot fail at spawn time.
 *
 * The catalog mirrors the locations and precedence pi itself advertises in
 * `<available_skills>`, so a name the model picked up there resolves here to
 * the same file: `.pi/skills` and `.agents/skills` for the project, then
 * `~/.pi/agent/skills` and `~/.agents/skills` for the user, with the first
 * directory that defines a name winning.
 *
 * Scope selects which of those directories apply, exactly as it does for agent
 * profiles, so an untrusted project (clamped to user scope) can never
 * contribute a skill.
 */

import * as fs from "node:fs";
import {
  loadSkillsFromDir,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

import type { Scope, Source } from "../model/ast.js";
import { projectSkillDirs, userSkillDirs } from "./paths.js";

/** A skill with its instructions already loaded. */
export interface ResolvedSkill {
  name: string;
  filePath: string;
  /** Directory relative references inside the instructions resolve against. */
  baseDir: string;
  /** Frontmatter-stripped, trimmed body. */
  instructions: string;
}

export type SkillFailure =
  | { name: string; reason: "unknown" }
  | { name: string; reason: "unreadable"; message: string };

/** A name defined by more than one directory; the first definition won. */
export interface SkillCollision {
  name: string;
  winner: string;
  loser: string;
}

/**
 * What one (cwd, scope) pair offers. Holds metadata plus a lazily filled cache
 * of stripped bodies, so preflight's read serves the later spawn and a wide
 * `map` neither rescans directories nor re-reads bodies per item.
 */
export interface SkillCatalog {
  readonly cwd: string;
  readonly scope: Scope;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly collisions: readonly SkillCollision[];
  readonly bodies: Map<string, string>;
}

/**
 * The directories a scope contributes, in precedence order. Project entries
 * precede user ones because that is the order pi resolves them in, and the
 * first definition of a name wins.
 */
function skillDirs(cwd: string, scope: Scope): Array<[string, Source]> {
  const dirs: Array<[string, Source]> = [];
  if (scope !== "user")
    for (const dir of projectSkillDirs(cwd)) dirs.push([dir, "project"]);
  if (scope !== "project")
    for (const dir of userSkillDirs()) dirs.push([dir, "user"]);
  return dirs;
}

/**
 * List the skills available for a cwd and scope, first definition winning.
 * Collisions are recorded rather than hidden: two directories defining one name
 * is a configuration smell worth surfacing, not a silent substitution.
 */
export function discoverSkills(cwd: string, scope: Scope): SkillCatalog {
  const skills = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  const seenPaths = new Set<string>();

  for (const [dir, source] of skillDirs(cwd, scope)) {
    for (const skill of loadSkillsFromDir({ dir, source }).skills) {
      // The same directory can be reachable twice (symlinks, nested walks).
      if (seenPaths.has(skill.filePath)) continue;
      seenPaths.add(skill.filePath);
      const existing = skills.get(skill.name);
      if (existing) {
        collisions.push({
          name: skill.name,
          winner: existing.filePath,
          loser: skill.filePath,
        });
        continue;
      }
      skills.set(skill.name, skill);
    }
  }

  return { cwd, scope, skills, collisions, bodies: new Map() };
}

/** Skill names a catalog offers, sorted for stable error messages. */
export function skillNames(catalog: SkillCatalog): string[] {
  return [...catalog.skills.keys()].sort((a, b) => a.localeCompare(b));
}

function readInstructions(
  skill: Skill,
  catalog: SkillCatalog,
): { instructions: string } | { message: string } {
  const cached = catalog.bodies.get(skill.filePath);
  if (cached !== undefined) return { instructions: cached };
  try {
    const body = stripFrontmatter(
      fs.readFileSync(skill.filePath, "utf-8"),
    ).trim();
    catalog.bodies.set(skill.filePath, body);
    return { instructions: body };
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve requested names against a catalog, loading the instructions of the
 * ones that exist. Unknown names and unreadable files are both failures: a
 * requested skill that cannot be delivered is a configuration error, never a
 * silently degraded prompt.
 */
export function resolveSkills(
  names: string[],
  catalog: SkillCatalog,
): { resolved: ResolvedSkill[]; failures: SkillFailure[] } {
  const resolved: ResolvedSkill[] = [];
  const failures: SkillFailure[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const skill = catalog.skills.get(name);
    if (!skill) {
      failures.push({ name, reason: "unknown" });
      continue;
    }
    const read = readInstructions(skill, catalog);
    if ("message" in read) {
      failures.push({ name, reason: "unreadable", message: read.message });
      continue;
    }
    resolved.push({
      name: skill.name,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      instructions: read.instructions,
    });
  }

  return { resolved, failures };
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Render resolved skills into a delegated agent's system prompt. Pure: no
 * filesystem access, no failure mode, no missing-skill note.
 */
export function renderSkillsPrompt(skills: readonly ResolvedSkill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map(
    (skill) =>
      `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.instructions}\n</skill>`,
  );
  return [
    "Apply the following skills when working on this task:",
    "",
    ...blocks,
  ]
    .join("\n")
    .trim();
}
