/**
 * The system prompt of agents: Pi's sections (preamble, tools, rules, project
 * context, skills, working directory) adapted for delegated work. The
 * profile body arrives separately as the agent's `instructions`.
 */

import {
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  type Extension,
  type PromptInput,
  section,
} from "@earendil-works/pi-durable";
import { DELEGATE_TOOL } from "../agents/delegation.js";
import { AgentsDoc } from "../agents/records.js";
import { USER_MESSAGE_PREFIX } from "../agents/types.js";
import type { SkillSource } from "../catalog/skills.js";
import { toolPromptContribution } from "./tools.js";

const PROMPT_EXTENSION = "pi-agents-prompt";

const AGENT_PREAMBLE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "Another agent gave you a task. It sees only your final message, so make that message a self-contained result with concrete file paths. If you need a decision, ask for it in your final message.",
  `Messages that start with ${USER_MESSAGE_PREFIX.trim()} come from the user, who sees your whole conversation. Answer the user directly.`,
].join("\n\n");

export interface PromptOptions {
  /** Whether project-local resources (context files, project skills) load. */
  trusted: () => boolean;
  /** The skills of a directory under the given trust. */
  skills: SkillSource;
}

type ContextFiles = Array<{ path: string; content: string }>;

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
  if (tools.includes(DELEGATE_TOOL)) add(DELEGATE_RULE);
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return rules.map((rule) => `- ${rule}`).join("\n");
}

/** What the prompt says about the tool of agents that delegate. */
const DELEGATE_SNIPPET =
  "Start helper agents for parts of your task and wait for their results";
const DELEGATE_RULE =
  "Use delegate_graph when your task splits into parts that can run on their own, such as one per file or area; give each helper a self-contained task";

function renderTools(tools: readonly string[]): string {
  const lines = tools.flatMap((name) => {
    if (name === DELEGATE_TOOL) return [`- ${name}: ${DELEGATE_SNIPPET}`];
    const snippet = toolPromptContribution(name).snippet;
    return snippet ? [`- ${name}: ${snippet}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function renderProjectContext(files: ContextFiles): string {
  return [
    "Project-specific instructions and guidelines:",
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ].join("\n\n");
}

export function createPromptExtension(options: PromptOptions): Extension {
  // Context files load once per directory, like Pi at startup.
  // Untrusted projects contribute none.
  const cache = new Map<string, ContextFiles>();
  const contextFiles = (cwd: string): ContextFiles => {
    if (!options.trusted()) return [];
    let found = cache.get(cwd);
    if (found === undefined) {
      found = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
      cache.set(cwd, found);
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
        const files = contextFiles(cwdOf(input));
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
        // Skills that don't load leave the agent without a catalog, as
        // they would leave Pi.
        const skills = await options
          .skills(cwdOf(input), options.trusted())
          .catch(() => []);
        if (skills.length === 0) return undefined;
        return formatSkillsForPrompt(skills, reader).trim() || undefined;
      }),
      section("cwd", (input) => cwdOf(input).replace(/\\/g, "/")),
    ],
  });
}
