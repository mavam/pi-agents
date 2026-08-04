/**
 * The AgentRunner implementation over the spawn engine: turns a resolved
 * invocation into a delegated pi process and streams its progress.
 *
 * All configuration decisions — profile lookup, skills, tools, model,
 * thinking, cwd, scope — belong to `resolveInvocation`, which preflight ran
 * first. This module only assembles the system prompt and spawns.
 */

import { renderSkillsPrompt } from "../catalog/skills.js";
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
  type OutputMode,
  type Scope,
} from "../model/ast.js";
import { BudgetExceededError } from "./budgets.js";
import type { AgentCall, AgentRunner } from "./interpreter.js";
import {
  CatalogCache,
  type ResolveModel,
  resolveInvocationOrThrow,
  type SpawnDefaults,
} from "./invocation.js";

export type { SpawnDefaults };

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
  /** Resolve explicit node/profile models to provider-qualified ids. */
  resolveModel?: ResolveModel;
  /** Effective budget limits, inherited by delegated processes. */
  budgetLimits?: EffectiveBudgets;
  /** Discovery caches shared with preflight, so resolution happens once. */
  catalogs?: CatalogCache;
  /** Observe a live handle; return a disposer that unregisters it. */
  onHandle?: (call: AgentCall, handle: SpawnHandle) => (() => void) | undefined;
}

/**
 * The result contract appended to every delegated agent's system prompt:
 * only the final message survives (see the value contract in the README),
 * so the agent must end with the deliverable itself.
 */
export function delegationPreamble(output: OutputMode): string {
  const lines = [
    "You run non-interactively as a delegated agent inside a workflow:",
    "this assignment is delegated work, not fresh user intent. Perform the",
    "assignment directly. Do not invoke workflows or delegate it further;",
    "if the assignment asks for delegation, perform the underlying work",
    "yourself. Nobody can reply to you, and only your final message is",
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
  const catalogs = options.catalogs ?? new CatalogCache();
  return async (call: AgentCall) => {
    const resolved = resolveInvocationOrThrow(call, {
      cwd: options.cwd,
      scope: options.scope ?? "both",
      trusted,
      defaults: options.defaults,
      resolveModel: options.resolveModel,
      catalogs,
    });
    const { cwd, profile } = resolved;

    // Persona (named calls only), then skills, then the result contract every
    // delegated agent gets — ad-hoc ones included.
    const parts: string[] = [];
    if (profile) parts.push(profile.systemPrompt);
    parts.push(renderSkillsPrompt(resolved.skills));
    parts.push(delegationPreamble(call.output));
    const systemPrompt = parts.filter(Boolean).join("\n\n");

    const env: Record<string, string> = {
      [DEPTH_ENV_VAR]: String(depth + 1),
    };
    if (options.budgetLimits) {
      env[BUDGETS_ENV_VAR] = JSON.stringify(options.budgetLimits);
    }

    const handle = options.engine.spawn({
      agent: profile?.name ?? ADHOC_LABEL,
      task: call.task,
      cwd,
      systemPrompt,
      model: resolved.model,
      thinking: resolved.thinking,
      disableSkillDiscovery: resolved.disableSkillDiscovery,
      // Preserved exactly: `[]` makes the engine emit --no-tools.
      tools: resolved.tools,
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
      // Drain remaining updates before judging the outcome: a breach found
      // there must win regardless of stream timing. Completed outcomes are
      // never failed retroactively on their final usage alone — turn
      // enforcement relies on the engine streaming activity.
      await progressPump.catch(() => {});
      if (breach) throw breach;
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
