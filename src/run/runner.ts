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
import {
  SpawnAborted,
  type SpawnEngine,
  type SpawnHandle,
} from "../engine/types.js";
import {
  ADHOC_LABEL,
  DEFAULT_BUDGETS,
  type EffectiveBudgets,
  effectiveScope,
  type OutputMode,
  type Scope,
} from "../model/ast.js";
import { BudgetExceededError } from "./budgets.js";
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
  budgetLimits?: EffectiveBudgets;
  /** Observe a live handle; return a disposer that unregisters it. */
  onHandle?: (call: AgentCall, handle: SpawnHandle) => (() => void) | undefined;
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
    const unregisterHandle = options.onHandle?.(call, handle);

    const onAbort = () => handle.abort();
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener("abort", onAbort, { once: true });

    // Per-agent budget watchdog: the first breach aborts the spawn and is
    // rethrown in place of the resulting SpawnAborted, carrying the agent's
    // last streamed output as the preserved partial result.
    const limits = options.budgetLimits ?? DEFAULT_BUDGETS;
    let breach: BudgetExceededError | undefined;
    let lastText = "";
    const cutOff = (message: string) => {
      if (breach) return;
      breach = new BudgetExceededError(message, lastText || undefined);
      handle.abort();
    };

    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    if (limits.maxAgentDuration !== undefined) {
      agentTimer = setTimeout(
        () =>
          cutOff(
            `agent duration budget exceeded (maxAgentDuration: ${limits.maxAgentDuration}s)`,
          ),
        limits.maxAgentDuration * 1000,
      );
      agentTimer.unref?.();
    }

    const progressPump = (async () => {
      for await (const update of handle.updates) {
        if (update.text) lastText = update.text;
        call.onProgress?.(update);
        // turnsStarted trips the cap the moment an over-budget turn begins;
        // completed-turn counts back it up for engines that don't report it.
        const turns = Math.max(update.turnsStarted ?? 0, update.usage.turns);
        if (turns > limits.maxTurns) {
          cutOff(`agent turn budget exceeded (maxTurns: ${limits.maxTurns})`);
        }
      }
    })();

    try {
      const outcome = await handle.wait();
      return { text: outcome.text, usage: outcome.usage };
    } catch (error) {
      if (breach && error instanceof SpawnAborted) throw breach;
      throw error;
    } finally {
      if (agentTimer) clearTimeout(agentTimer);
      call.signal.removeEventListener("abort", onAbort);
      await progressPump.catch(() => {});
      unregisterHandle?.();
    }
  };
}
