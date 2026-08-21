/**
 * The AgentRunner implementation over the spawn engine: turns a resolved
 * invocation into a delegated pi process and streams its progress.
 *
 * All configuration decisions — profile lookup, skills, tools, model,
 * thinking, cwd, scope — belong to `resolveInvocation`, which preflight ran
 * first. This module only assembles the system prompt and spawns.
 */

import { renderSkillsPrompt } from "../catalog/skills.js";
import { DEPTH_ENV_VAR } from "../engine/subprocess.js";
import {
  SpawnAborted,
  type SpawnEngine,
  type SpawnHandle,
} from "../engine/types.js";
import {
  ADHOC_LABEL,
  DEFAULT_BUDGETS,
  type EffectiveBudgets,
  type Scope,
} from "../model/ast.js";
import { resultValueError } from "../model/json-schema.js";
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
  /** Active session model/thinking, used when the agent file sets none. */
  defaults?: SpawnDefaults;
  /** Resolve explicit node/profile models to provider-qualified ids. */
  resolveModel?: ResolveModel;
  /** Effective budget limits enforced by the per-agent watchdog. */
  budgetLimits?: EffectiveBudgets;
  /** Discovery caches shared with preflight, so resolution happens once. */
  catalogs?: CatalogCache;
  /** Directory for delegated agents' own session files (one per run). */
  sessionDir?: string;
  /** Observe a live handle; return a disposer that unregisters it. */
  onHandle?: (call: AgentCall, handle: SpawnHandle) => (() => void) | undefined;
}

/** The result contract appended to every delegated agent's system prompt. */
export function delegationPreamble(): string {
  return [
    "You run as a delegated agent inside a workflow: this assignment is",
    "delegated work, not fresh user intent. Perform the assignment",
    "directly. Do not invoke workflows or delegate it further; if the",
    "assignment asks for delegation, perform the underlying work yourself.",
    "A supervising user may attach to your session and send you messages",
    "mid-run. Treat every such message as authoritative steering: reply to",
    "it briefly and directly in your assistant text, adjust course as it",
    "directs, and only then continue the assignment. If the user",
    "interrupts your current activity, do not blindly resume it — their",
    "next message overrides your previous plan. Apart from these steering",
    "exchanges, assistant messages are progress notes and are not returned",
    "to the caller. Complete the assignment by submitting exactly one",
    "complete agent result through the provided",
    "result-submission mechanism as your final action. If the assignment",
    "cannot be completed, or the user tells you to stop, submit an error",
    "with a concrete reason instead of fabricating a result.",
  ].join("\n");
}

export function createAgentRunner(options: RunnerOptions): AgentRunner {
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
    const agentName = profile?.name ?? ADHOC_LABEL;

    // Persona (named calls only), then skills, then the result contract every
    // delegated agent gets — ad-hoc ones included.
    const parts: string[] = [];
    if (profile) parts.push(profile.systemPrompt);
    parts.push(renderSkillsPrompt(resolved.skills));
    parts.push(delegationPreamble());
    const systemPrompt = parts.filter(Boolean).join("\n\n");

    // pi-agents registers only in the root process (depth 0), so every
    // delegated child sits at depth 1. The marker keeps pi-agents inert in
    // any Pi process the child may launch with an inherited environment.
    const env: Record<string, string> = {
      [DEPTH_ENV_VAR]: "1",
    };

    const handle = options.engine.spawn({
      agent: agentName,
      task: call.task,
      cwd,
      systemPrompt,
      model: resolved.model,
      thinking: resolved.thinking,
      disableSkillDiscovery: resolved.disableSkillDiscovery,
      // Preserved exactly: the engine adds only its mandatory result tool.
      tools: resolved.tools,
      resultSchema: call.resultSchema,
      sessionDir: options.sessionDir,
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
      const validationError = resultValueError(
        outcome.value,
        call.resultSchema,
      );
      if (validationError) {
        throw new Error(
          `Spawn engine for agent ${agentName} returned a result that violates the declared result schema: ${validationError}.`,
        );
      }
      return { value: outcome.value, usage: outcome.usage };
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
