/**
 * The system prompt of agents: Pi's sections (preamble, tools, rules, project
 * context, skills, working directory) adapted for delegated work. The
 * profile body arrives separately as the agent's `instructions`.
 */

import {
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  type Extension,
  type PromptInput,
  section,
} from "@earendil-works/pi-durable";
import { AgentsDoc } from "../agents/records.js";
import { toolPromptContribution } from "./tools.js";

export const PROMPT_EXTENSION = "pi-agents-prompt";

export const AGENT_PREAMBLE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help by reading files, executing commands, editing code, and writing new files.",
  "",
  "You are a delegated agent: another agent (your parent) gave you a task. Work autonomously and do not ask questions back unless you cannot proceed. Your parent sees only your final message, never your tool calls or intermediate text. Make your final message a self-contained result: what you found or changed, with concrete file paths, and anything left unresolved. If you cannot complete the task, say so and why.",
].join("\n");

export interface PromptOptions {
  /** Whether project-local resources (context files, project skills) load. */
  trusted: () => boolean;
  /** Extra skill paths from Pi's settings. */
  skillPaths: () => string[];
}

interface Resources {
  contextFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
}

function buildRules(tools: readonly string[]): string {
  const rules: string[] = [];
  const add = (rule: string) => {
    const trimmed = rule.trim();
    if (trimmed && !rules.includes(trimmed)) rules.push(trimmed);
  };
  const searches = ["grep", "find", "ls"].some((name) => tools.includes(name));
  if (tools.includes("bash") && !searches)
    add("Use bash for file operations like ls, rg, find");
  for (const name of tools)
    for (const rule of toolPromptContribution(name).guidelines) add(rule);
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return rules.map((rule) => `- ${rule}`).join("\n");
}

function renderTools(tools: readonly string[]): string {
  const lines = tools.flatMap((name) => {
    const snippet = toolPromptContribution(name).snippet;
    return snippet ? [`- ${name}: ${snippet}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function renderProjectContext(files: Resources["contextFiles"]): string {
  return [
    "Project-specific instructions and guidelines:",
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ].join("\n\n");
}

export function createPromptExtension(options: PromptOptions): Extension {
  // Context files and skills load once per directory and trust, like Pi at
  // startup.
  const cache = new Map<string, Resources>();
  const resources = (cwd: string): Resources => {
    const trusted = options.trusted();
    const key = `${trusted}:${cwd}`;
    let found = cache.get(key);
    if (found === undefined) {
      const agentDir = getAgentDir();
      found = trusted
        ? {
            contextFiles: loadProjectContextFiles({ cwd, agentDir }),
            skills: loadSkills({
              cwd,
              agentDir,
              skillPaths: options.skillPaths(),
              includeDefaults: true,
            }).skills,
          }
        : { contextFiles: [], skills: [] };
      cache.set(key, found);
    }
    return found;
  };
  const cwdOf = (input: PromptInput) =>
    input.env?.cwd ?? input.agent.cwd ?? process.cwd();
  const toolNames = (input: PromptInput) =>
    input.agent.tools.map((tool) => tool.name);

  return defineExtension({
    name: PROMPT_EXTENSION,
    sections: [
      section("preamble", () => AGENT_PREAMBLE, { tag: false }),
      section("tools", (input) => renderTools(toolNames(input))),
      section("rules", (input) => buildRules(toolNames(input))),
      section("project_context", (input) => {
        const files = resources(cwdOf(input)).contextFiles;
        return files.length > 0 ? renderProjectContext(files) : undefined;
      }),
      section("skills", async (input, context) => {
        const state = await input.read.snapshot(AgentsDoc, context);
        const record = state?.agents[String(input.conversationId)];
        if (record && !record.ambientSkills) return undefined;
        const tools = toolNames(input);
        const reader = tools.includes("read")
          ? "read"
          : tools.includes("bash")
            ? "bash"
            : undefined;
        if (reader === undefined) return undefined;
        const skills = resources(cwdOf(input)).skills;
        if (skills.length === 0) return undefined;
        return formatSkillsForPrompt(skills, reader).trim() || undefined;
      }),
      section("cwd", (input) => cwdOf(input).replace(/\\/g, "/")),
    ],
  });
}
