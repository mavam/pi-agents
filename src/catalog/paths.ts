/**
 * Where agents, skills, and workflows live.
 *
 * One project root serves every resource kind: profiles, skills, and saved
 * workflows always come from the same `.pi` directory. Walking separately per
 * kind would let a run combine a parent project's profile with a child
 * project's skill catalog, and would make project trust — decided for a single
 * project — meaningless.
 *
 * User-scope resources live inside pi's agent dir (~/.pi/agent), matching
 * pi's own conventions for skills, prompts, and tools, and inheriting the
 * PI_CODING_AGENT_DIR override wholesale.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Resource kinds sharing one project root. */
export type ResourceKind = "agents" | "skills" | "workflows";

const CONFIG_DIR = ".pi";

/**
 * The second skills convention pi honors, alongside `.pi/skills`: `.agents`
 * directories, which hold portable Agent Skills shared across tools.
 */
const AGENTS_DIR = ".agents";

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor of `cwd` (inclusive) holding a `.pi` directory, or null
 * when there is none. A `.pi` that *is* pi's agent dir is skipped: with
 * PI_CODING_AGENT_DIR pointing at a `.pi` directory, user resources would
 * otherwise masquerade as project ones.
 */
export function findProjectRoot(cwd: string): string | null {
  const agentDir = path.resolve(getAgentDir());
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, CONFIG_DIR);
    if (isDirectory(candidate) && path.resolve(candidate) !== agentDir)
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `<root>/.pi/<kind>` for a project root from `findProjectRoot`. */
export function projectResourceDir(root: string, kind: ResourceKind): string {
  return path.join(root, CONFIG_DIR, kind);
}

/** `<agentDir>/<kind>` — the user-scope location for a resource kind. */
export function userResourceDir(kind: ResourceKind): string {
  return path.join(getAgentDir(), kind);
}

/**
 * The project directory for one resource kind, or null when the cwd has no
 * project root. The directory itself need not exist; loaders treat a missing
 * directory as empty.
 */
export function findProjectResourceDir(
  cwd: string,
  kind: ResourceKind,
): string | null {
  const root = findProjectRoot(cwd);
  return root === null ? null : projectResourceDir(root, kind);
}

function findGitRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Home directory, resolved the way pi resolves it. */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** `~/.agents/skills` — the user-scope portable skills directory. */
function userAgentsSkillsDir(): string {
  return path.join(homeDir(), AGENTS_DIR, "skills");
}

/**
 * `.agents/skills` from the cwd up to the enclosing git repository root
 * (inclusive), nearest first, mirroring how pi collects them. Without a git
 * root the walk stops at the cwd, so an unrelated ancestor never contributes.
 */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const gitRoot = findGitRepoRoot(cwd);
  let dir = path.resolve(cwd);
  while (true) {
    dirs.push(path.join(dir, AGENTS_DIR, "skills"));
    if (gitRoot === null || dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * User-scope skill directories, in pi's precedence order. Always available:
 * user resources are not gated on project trust.
 */
export function userSkillDirs(): string[] {
  return [userResourceDir("skills"), userAgentsSkillsDir()];
}

/**
 * Project-scope skill directories, in pi's precedence order: `.pi/skills` from
 * the project root, then every `.agents/skills` from the cwd up to the git
 * root. The user's own `~/.agents/skills` is excluded so it stays user-scoped
 * even when the cwd sits under the home directory.
 *
 * Callers must only use these when the effective scope permits project
 * resources, which is how project trust gates them.
 */
export function projectSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const piDir = findProjectResourceDir(cwd, "skills");
  if (piDir !== null) dirs.push(piDir);
  const userAgents = path.resolve(userAgentsSkillsDir());
  for (const dir of ancestorAgentsSkillDirs(cwd))
    if (path.resolve(dir) !== userAgents) dirs.push(dir);
  return dirs;
}
