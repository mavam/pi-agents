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
import { SEND_TOOL, STATUS_TOOL } from "../agents/messaging.js";
import { RESULTS_PREFIX } from "../agents/obligations.js";
import { AgentsDoc } from "../agents/records.js";
import { SPAWN_TOOL, STOP_TOOL, WAIT_TOOL } from "../agents/spawning.js";
import { USER_MESSAGE_PREFIX } from "../agents/types.js";
import type { SkillSource } from "../catalog/skills.js";
import { toolPromptContribution } from "./tools.js";

const PROMPT_EXTENSION = "pi-agents-prompt";

const AGENT_PREAMBLE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "The agent that started you gave you a job. It sees only your final message, so make that message a self-contained result with concrete file paths. If you need a decision, ask for it in your final message.",
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
  if (tools.includes(SPAWN_TOOL)) add(SPAWN_RULE);
  if (tools.includes(SEND_TOOL)) add(MESSAGING_RULE);
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return rules.map((rule) => `- ${rule}`).join("\n");
}

/** What the prompt says about the tools of agents that spawn. */
const SPAWNING_SNIPPETS: Record<string, string> = {
  [SPAWN_TOOL]:
    "Spawn agents for parts of your job; their result arrives as a message",
  [WAIT_TOOL]: "Block until agents you spawned finished and get their results",
  [STOP_TOOL]: "Stop agents you spawned",
};
const SPAWN_RULE = `Use ${SPAWN_TOOL} when your job splits into parts that can run on their own, such as one per file or area. Inputs that start with ${RESULTS_PREFIX.trim()} carry the results of agents you spawned. Your job ends with your first answer after the results of every group you spawned, so after spawning, continue with other work, end your turn until the results arrive, or call ${WAIT_TOOL}`;

/** What the prompt says about messaging other agents. */
const MESSAGING_SNIPPETS: Record<string, string> = {
  [STATUS_TOOL]: "List the agents you can message and their jobs",
  [SEND_TOOL]: "Send another agent a message without waiting for its answer",
};
const MESSAGING_RULE =
  "Messages that start with [from <name>] come from other agents, not the user. To hear back from an agent, ask it to message you with agent_send";

function renderTools(tools: readonly string[]): string {
  const lines = tools.flatMap((name) => {
    const spawning = SPAWNING_SNIPPETS[name];
    if (spawning) return [`- ${name}: ${spawning}`];
    const messaging = MESSAGING_SNIPPETS[name];
    if (messaging) return [`- ${name}: ${messaging}`];
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
