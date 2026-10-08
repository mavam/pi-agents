/**
 * Agent profiles: reusable spawn defaults in Markdown files with frontmatter.
 * User profiles live in `~/.pi/agent/agents`, project profiles in the nearest
 * `.pi/agents`; project profiles win on name conflicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  isThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../agents/types.js";
import { findProjectResourceDir, userResourceDir } from "./paths.js";

/** Which resource locations apply: untrusted projects use `user`. */
export type Scope = "user" | "project" | "both";

export type Source = "user" | "project";

export interface Profile {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** Skills to apply; absent keeps the ambient skill catalog. */
  skills?: string[];
  /** Tool allowlist; absent selects the default tools. */
  tools?: string[];
  /** The Markdown body, appended to the agent's system prompt. */
  instructions: string;
  source: Source;
  filePath: string;
}

interface Diagnostic {
  source: Source;
  filePath: string;
  message: string;
}

export interface ProfileCatalog {
  profiles: Profile[];
  diagnostics: Diagnostic[];
}

const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "skills",
  "tools",
]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A YAML array of strings or a comma-separated string. An explicitly empty
 * list is preserved: it means "none", not "default". */
function parseList(
  raw: unknown,
  key: string,
): string[] | undefined | { error: string } {
  if (raw === undefined) return undefined;
  let names: string[];
  if (typeof raw === "string") names = raw.split(",");
  else if (Array.isArray(raw) && raw.every((item) => typeof item === "string"))
    names = raw as string[];
  else
    return {
      error: `Invalid '${key}' (must be a YAML array of strings or a comma-separated string)`,
    };
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/** A parsed profile, or an error message. */
export function parseProfileFile(
  filePath: string,
  source: Source,
): Profile | string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    return `Could not read file: ${toErrorMessage(error)}`;
  }
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (error) {
    return `Could not parse frontmatter: ${toErrorMessage(error)}`;
  }

  const unknownKeys = Object.keys(frontmatter).filter(
    (key) => !ALLOWED_FRONTMATTER_KEYS.has(key),
  );
  if (unknownKeys.length > 0)
    return `Unsupported frontmatter keys: ${unknownKeys.join(", ")}. Allowed keys: ${[...ALLOWED_FRONTMATTER_KEYS].join(", ")}.`;
  const { name, description, model, thinking } = frontmatter;
  if (typeof name !== "string" || !name.trim())
    return "Missing or invalid 'name' (must be a non-empty string)";
  if (typeof description !== "string" || !description.trim())
    return "Missing or invalid 'description' (must be a non-empty string)";
  if (model !== undefined && typeof model !== "string")
    return "Invalid 'model' (must be a string)";
  if (thinking !== undefined && !isThinkingLevel(thinking))
    return `Invalid 'thinking' (must be one of ${THINKING_LEVELS.join("|")})`;
  const skills = parseList(frontmatter.skills, "skills");
  if (skills && "error" in skills) return skills.error;
  const tools = parseList(frontmatter.tools, "tools");
  if (tools && "error" in tools) return tools.error;

  return {
    name: name.trim(),
    description: description.trim(),
    ...(typeof model === "string" && model.trim()
      ? { model: model.trim() }
      : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(skills ? { skills } : {}),
    ...(tools ? { tools } : {}),
    instructions: body.trim(),
    source,
    filePath,
  };
}

function loadProfilesFromDir(dir: string, source: Source): ProfileCatalog {
  const catalog: ProfileCatalog = { profiles: [], diagnostics: [] };
  if (!fs.existsSync(dir)) return catalog;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    catalog.diagnostics.push({
      source,
      filePath: dir,
      message: `Could not read directory: ${toErrorMessage(error)}`,
    });
    return catalog;
  }
  for (const entry of entries) {
    if (
      !entry.name.endsWith(".md") ||
      (!entry.isFile() && !entry.isSymbolicLink())
    )
      continue;
    const filePath = path.join(dir, entry.name);
    const result = parseProfileFile(filePath, source);
    if (typeof result === "string")
      catalog.diagnostics.push({ source, filePath, message: result });
    else catalog.profiles.push(result);
  }
  return catalog;
}

export function discoverProfiles(cwd: string, scope: Scope): ProfileCatalog {
  const projectDir = findProjectResourceDir(cwd, "agents");
  const empty: ProfileCatalog = { profiles: [], diagnostics: [] };
  const user =
    scope !== "project"
      ? loadProfilesFromDir(userResourceDir("agents"), "user")
      : empty;
  const project =
    scope !== "user" && projectDir
      ? loadProfilesFromDir(projectDir, "project")
      : empty;
  const merged = new Map<string, Profile>();
  for (const profile of user.profiles) merged.set(profile.name, profile);
  for (const profile of project.profiles) merged.set(profile.name, profile);
  return {
    profiles: [...merged.values()].sort(
      (left, right) =>
        Number(right.source === "project") -
          Number(left.source === "project") ||
        left.name.localeCompare(right.name),
    ),
    diagnostics: [...user.diagnostics, ...project.diagnostics],
  };
}

/** Exact match first, then a unique case-insensitive one. */
export function findProfile(
  profiles: readonly Profile[],
  name: string,
): Profile | undefined {
  const exact = profiles.find((profile) => profile.name === name);
  if (exact) return exact;
  const lowered = name.toLowerCase();
  const matches = profiles.filter(
    (profile) => profile.name.toLowerCase() === lowered,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
