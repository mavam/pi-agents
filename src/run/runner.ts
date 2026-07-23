/**
 * The AgentRunner implementation over the spawn engine: resolves named agents
 * from the catalog and assembles their system prompt (body + skills), or
 * spawns anonymous ad-hoc calls as plain delegated pi processes, then streams
 * progress.
 */

import {
  type Agent,
  buildSkillsPrompt,
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
} from "../catalog/agents.js";
import { BUDGETS_ENV_VAR, DEPTH_ENV_VAR } from "../engine/subprocess.js";
import type { SpawnEngine } from "../engine/types.js";
import {
  ADHOC_LABEL,
  type Budgets,
  effectiveScope,
  type OutputMode,
  type Scope,
} from "../model/ast.js";
import type { AgentCall, AgentRunner } from "./interpreter.js";

/** Session-level fallbacks for agents without explicit frontmatter. */
export interface SpawnDefaults {
  model?: string;
  thinking?: string;
}

export interface RunnerOptions {
  engine: SpawnEngine;
  /** Default working directory for delegated processes. */
  cwd: string;
  /** Default agent discovery scope. */
  scope?: Scope;
  /** Project trust; when false, per-call scope overrides clamp to user. */
  trusted?: boolean;
  /** Cross-process delegation depth of the current process. */
  depth?: number;
  /** Active session model/thinking, used when the agent file sets none. */
  defaults?: SpawnDefaults;
  /** Effective budget limits, inherited by delegated processes. */
  budgetLimits?: Required<Budgets>;
}

/** Resolve one agent by name or throw with an actionable message. */
export function resolveAgentOrThrow(
  name: string,
  cwd: string,
  scope: Scope,
): Agent {
  const discovery = discoverAgents(cwd, scope);
  const resolution = resolveAgentByName(discovery.agents, name);
  switch (resolution.kind) {
    case "exact":
    case "case_insensitive":
      return resolution.agent;
    case "ambiguous":
      throw new Error(
        `agent name '${name}' is ambiguous: ${resolution.matches.map((a) => a.name).join(", ")}`,
      );
    case "missing":
      throw new Error(
        `unknown agent '${name}' (scope: ${scope}). Available: ${formatAgentList(discovery.agents)}`,
      );
  }
}

/**
 * The result contract appended to every delegated agent's system prompt:
 * only the final message survives (see the value contract in the README),
 * so the agent must end with the deliverable itself.
 */
export function delegationPreamble(output: OutputMode): string {
  const lines = [
    "You run non-interactively as a delegated agent inside a workflow:",
    "nobody can reply to you, and only the text of your final message is",
    "returned to the caller as your result — everything before it is",
    "discarded. End your turn with one dedicated message containing the",
    "complete deliverable itself, not a summary of what you did, a",
    "reference to earlier messages, or a closing remark.",
  ];
  if (output === "json") {
    lines.push(
      "",
      "The caller parses your result as JSON: your final message must be a",
      "single JSON value with no surrounding prose (a ```json fence is",
      "acceptable).",
    );
  }
  return lines.join("\n");
}

export function createAgentRunner(options: RunnerOptions): AgentRunner {
  const depth = options.depth ?? 0;
  const trusted = options.trusted ?? true;
  return async (call: AgentCall) => {
    const cwd = call.cwd ?? options.cwd;
    const scope = effectiveScope(call.scope, trusted, options.scope ?? "both");
    // Named calls resolve a catalog profile; anonymous (ad-hoc) calls skip
    // discovery entirely and spawn a plain delegated pi process.
    const agent =
      call.agent !== undefined
        ? resolveAgentOrThrow(call.agent, cwd, scope)
        : undefined;

    // Persona and skills first (named agents only), then the result
    // contract every delegated agent gets — ad-hoc ones included.
    const parts: string[] = [];
    if (agent) {
      const { prompt: skillsPrompt } = buildSkillsPrompt(agent.skills, cwd);
      parts.push(agent.systemPrompt, skillsPrompt);
    }
    parts.push(delegationPreamble(call.output));
    const systemPrompt = parts.filter(Boolean).join("\n\n");

    const env: Record<string, string> = {
      [DEPTH_ENV_VAR]: String(depth + 1),
    };
    if (options.budgetLimits) {
      env[BUDGETS_ENV_VAR] = JSON.stringify(options.budgetLimits);
    }

    const handle = options.engine.spawn({
      agent: agent?.name ?? ADHOC_LABEL,
      task: call.task,
      cwd,
      systemPrompt,
      // Precedence: flow node override > agent file > active session default.
      model: call.model ?? agent?.model ?? options.defaults?.model,
      thinking: call.thinking ?? agent?.thinking ?? options.defaults?.thinking,
      tools: agent?.tools,
      env,
    });

    const onAbort = () => handle.abort();
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener("abort", onAbort, { once: true });

    const progressPump = (async () => {
      for await (const update of handle.updates) {
        call.onProgress?.(update.text, update.usage);
      }
    })();

    try {
      const outcome = await handle.wait();
      return { text: outcome.text, usage: outcome.usage };
    } finally {
      call.signal.removeEventListener("abort", onAbort);
      await progressPump.catch(() => {});
    }
  };
}
