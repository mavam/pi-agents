import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getAgentDir,
  loadSkills,
  parseFrontmatter,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

// --- Types ---

import type { Scope, Source } from "../model/ast.js";

export type { Scope, Source };

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export type Thinking = ThinkingLevel;

export interface Agent {
  name: string;
  description: string;
  model?: string;
  thinking?: Thinking;
  skills: string[];
  /** Tool allowlist for the delegated process (passed as `--tools`). */
  tools?: string[];
  systemPrompt: string;
  source: Source;
  filePath: string;
}

export interface Diagnostic {
  source: Source;
  filePath: string;
  message: string;
}

export interface DiscoveryResult {
  agents: Agent[];
  diagnostics: Diagnostic[];
  projectAgentsDir: string | null;
}

// --- Internal Helpers ---

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);
const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "skills",
  "tools",
]);

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getUserAgentsDir(): string {
  return path.join(path.dirname(getAgentDir()), "agents");
}

function getUserSkillsDir(): string {
  return path.join(path.dirname(getAgentDir()), "skills");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- Parsing & Validation ---

/** Returns a parsed `Agent` on success, or an error message string on failure. */
function parseAgentFile(filePath: string, source: Source): Agent | string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return `Could not read file: ${toErrorMessage(e)}`;
  }

  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    fm = parsed.frontmatter;
    body = parsed.body;
  } catch (e) {
    return `Could not parse frontmatter: ${toErrorMessage(e)}`;
  }

  const unknownKeys = Object.keys(fm).filter(
    (k) => !ALLOWED_FRONTMATTER_KEYS.has(k),
  );
  if (unknownKeys.length > 0)
    return `Unsupported frontmatter keys: ${unknownKeys.join(", ")}. Allowed keys: ${[...ALLOWED_FRONTMATTER_KEYS].join(", ")}.`;

  if (typeof fm.name !== "string" || !fm.name.trim())
    return "Missing or invalid 'name' (must be a non-empty string)";
  if (typeof fm.description !== "string" || !fm.description.trim())
    return "Missing or invalid 'description' (must be a non-empty string)";
  if (fm.model !== undefined && typeof fm.model !== "string")
    return "Invalid 'model' (must be a string)";
  if (
    fm.thinking !== undefined &&
    (typeof fm.thinking !== "string" || !THINKING_LEVEL_SET.has(fm.thinking))
  )
    return `Invalid 'thinking' (must be one of ${THINKING_LEVELS.join("|")})`;
  if (
    fm.skills !== undefined &&
    (!Array.isArray(fm.skills) || fm.skills.some((s) => typeof s !== "string"))
  )
    return "Invalid 'skills' (must be a YAML array of strings)";
  const tools = parseToolsField(fm.tools);
  if (typeof tools === "object" && tools !== null && "error" in tools)
    return tools.error;

  return {
    name: (fm.name as string).trim(),
    description: (fm.description as string).trim(),
    model:
      typeof fm.model === "string" && fm.model.trim()
        ? fm.model.trim()
        : undefined,
    thinking: fm.thinking as Thinking | undefined,
    skills: fm.skills
      ? [
          ...new Set(
            (fm.skills as string[]).map((s) => s.trim()).filter(Boolean),
          ),
        ]
      : [],
    tools,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
}

/**
 * `tools` accepts a YAML array of strings or a comma-separated string. An
 * explicitly empty list is preserved: it means "no tools", not "all tools".
 */
function parseToolsField(
  raw: unknown,
): string[] | undefined | { error: string } {
  if (raw === undefined) return undefined;
  let names: string[];
  if (typeof raw === "string") {
    names = raw.split(",");
  } else if (Array.isArray(raw) && raw.every((t) => typeof t === "string")) {
    names = raw as string[];
  } else {
    return {
      error:
        "Invalid 'tools' (must be a YAML array of strings or a comma-separated string)",
    };
  }
  return [...new Set(names.map((t) => t.trim()).filter(Boolean))];
}

function loadAgentsFromDir(
  dir: string,
  source: Source,
): { agents: Agent[]; diagnostics: Diagnostic[] } {
  const agents: Agent[] = [];
  const diagnostics: Diagnostic[] = [];

  if (!fs.existsSync(dir)) return { agents, diagnostics };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    diagnostics.push({
      source,
      filePath: dir,
      message: `Could not read directory: ${toErrorMessage(e)}`,
    });
    return { agents, diagnostics };
  }

  for (const entry of entries) {
    if (
      !entry.name.endsWith(".md") ||
      (!entry.isFile() && !entry.isSymbolicLink())
    )
      continue;

    const filePath = path.join(dir, entry.name);
    const result = parseAgentFile(filePath, source);

    if (typeof result === "string") {
      diagnostics.push({ source, filePath, message: result });
    } else {
      agents.push(result);
    }
  }

  return { agents, diagnostics };
}

// --- Discovery ---

function findNearestProjectAgentsDir(cwd: string): string | null {
  const userAgentsDir = path.resolve(getUserAgentsDir());
  let dir = path.resolve(cwd);

  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (isDirectory(candidate) && path.resolve(candidate) !== userAgentsDir)
      return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findNearestProjectSkillsCwd(cwd: string): string | null {
  const userSkillsDir = path.resolve(getUserSkillsDir());
  let dir = path.resolve(cwd);

  while (true) {
    const candidate = path.join(dir, ".pi", "skills");
    if (isDirectory(candidate) && path.resolve(candidate) !== userSkillsDir)
      return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const EMPTY_LOAD_RESULT = {
  agents: [] as Agent[],
  diagnostics: [] as Diagnostic[],
};

export function discoverAgents(cwd: string, scope: Scope): DiscoveryResult {
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const user =
    scope !== "project"
      ? loadAgentsFromDir(getUserAgentsDir(), "user")
      : EMPTY_LOAD_RESULT;
  const project =
    scope !== "user" && projectAgentsDir
      ? loadAgentsFromDir(projectAgentsDir, "project")
      : EMPTY_LOAD_RESULT;

  // Merge by name; project agents win on conflicts.
  const merged = new Map<string, Agent>();
  for (const a of user.agents) merged.set(a.name, a);
  for (const a of project.agents) merged.set(a.name, a);

  return {
    agents: [...merged.values()],
    diagnostics: [...user.diagnostics, ...project.diagnostics],
    projectAgentsDir,
  };
}

// --- Formatting ---

export function formatAgentList(agents: Agent[]): string {
  if (agents.length === 0) return "none";
  return agents
    .map((a) => `${a.name} (${a.source}): ${a.description}`)
    .join("; ");
}

export function resolveAgentByName(
  agents: Agent[],
  name: string,
):
  | { kind: "exact"; agent: Agent }
  | { kind: "case_insensitive"; agent: Agent }
  | { kind: "ambiguous"; matches: Agent[] }
  | { kind: "missing" } {
  const exact = agents.find((agent) => agent.name === name);
  if (exact) return { kind: "exact", agent: exact };

  const lowered = name.toLowerCase();
  const matches = agents.filter(
    (agent) => agent.name.toLowerCase() === lowered,
  );
  if (matches.length === 1) {
    const [agent] = matches;
    if (agent) return { kind: "case_insensitive", agent };
  }
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "missing" };
}

// --- Skills ---

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildSkillsPrompt(
  skillNames: string[],
  cwd: string,
): { prompt: string; missingSkills: string[] } {
  const normalized = [
    ...new Set(skillNames.map((s) => s.trim()).filter(Boolean)),
  ];
  if (normalized.length === 0) return { prompt: "", missingSkills: [] };

  const skillsCwd = findNearestProjectSkillsCwd(cwd) ?? cwd;
  const { skills } = loadSkills({
    cwd: skillsCwd,
    agentDir: getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });
  const byName = new Map(skills.map((s) => [s.name, s]));

  const blocks: string[] = [];
  const missingSkills: string[] = [];

  for (const name of normalized) {
    const skill = byName.get(name);
    if (!skill) {
      missingSkills.push(name);
      continue;
    }
    try {
      const content = fs.readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      blocks.push(
        `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
      );
    } catch {
      missingSkills.push(name);
    }
  }

  const parts: string[] = [];
  if (blocks.length > 0)
    parts.push(
      "Apply the following skills when working on this task:",
      "",
      ...blocks,
    );
  if (missingSkills.length > 0)
    parts.push("", `Missing skills (not found): ${missingSkills.join(", ")}`);

  return { prompt: parts.join("\n").trim(), missingSkills };
}

// Model agent injection after skill injection: provide a structured XML block
// with stable location/reference metadata plus the normalized agent metadata and
// body.
export function buildAgentsPrompt(
  cwd: string,
  scope: Scope,
): { prompt: string; diagnostics: Diagnostic[] } {
  const discovery = discoverAgents(cwd, scope);
  const agents = [...discovery.agents].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "project" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  const lines = [
    `<agents scope="${escapeXmlAttribute(scope)}" cwd="${escapeXmlAttribute(cwd)}">`,
  ];

  if (agents.length === 0) {
    lines.push(
      "  <none>No agents were discovered for this cwd and scope.</none>",
    );
  } else {
    for (const agent of agents) {
      lines.push(
        `  <agent name="${escapeXmlAttribute(agent.name)}" source="${escapeXmlAttribute(agent.source)}" location="${escapeXmlAttribute(agent.filePath)}">`,
        `    <references>References are relative to ${escapeXmlText(path.dirname(agent.filePath))}.</references>`,
        "    <frontmatter>",
        `      <description>${escapeXmlText(agent.description)}</description>`,
      );

      if (agent.model) {
        lines.push(`      <model>${escapeXmlText(agent.model)}</model>`);
      }
      if (agent.thinking) {
        lines.push(
          `      <thinking>${escapeXmlText(agent.thinking)}</thinking>`,
        );
      }
      if (agent.tools && agent.tools.length > 0) {
        lines.push(
          `      <tools>${escapeXmlText(agent.tools.join(", "))}</tools>`,
        );
      }

      lines.push("      <skills>");
      if (agent.skills.length === 0) {
        lines.push("        <none>(none)</none>");
      } else {
        for (const skill of agent.skills) {
          lines.push(`        <skill>${escapeXmlText(skill)}</skill>`);
        }
      }
      lines.push("      </skills>", "    </frontmatter>");

      if (agent.systemPrompt) {
        lines.push(
          "    <system-prompt>",
          escapeXmlText(agent.systemPrompt),
          "    </system-prompt>",
        );
      }

      lines.push("  </agent>");
    }
  }

  if (discovery.diagnostics.length > 0) {
    lines.push("  <diagnostics>");
    for (const diagnostic of discovery.diagnostics) {
      lines.push(
        `    <diagnostic source="${escapeXmlAttribute(diagnostic.source)}" path="${escapeXmlAttribute(diagnostic.filePath)}">${escapeXmlText(diagnostic.message)}</diagnostic>`,
      );
    }
    lines.push("  </diagnostics>");
  }

  lines.push("</agents>");

  return {
    prompt: lines.join("\n"),
    diagnostics: discovery.diagnostics,
  };
}
