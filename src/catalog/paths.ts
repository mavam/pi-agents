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
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Resource kinds sharing one project root. */
export type ResourceKind = "agents" | "skills" | "workflows";

const CONFIG_DIR = ".pi";

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
