/**
 * The AgentRunner implementation over the spawn engine: resolves the agent by
 * name from the catalog, assembles its system prompt (body + skills), spawns
 * a delegated pi process, and streams progress.
 */

import {
  type Agent,
  buildSkillsPrompt,
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
} from "../catalog/agents.js";
import { DEPTH_ENV_VAR } from "../engine/subprocess.js";
import type { SpawnEngine } from "../engine/types.js";
import type { Scope } from "../model/ast.js";
import type { AgentCall, AgentRunner } from "./interpreter.js";

export interface RunnerOptions {
  engine: SpawnEngine;
  /** Default working directory for delegated processes. */
  cwd: string;
  /** Default agent discovery scope. */
  scope?: Scope;
  /** Cross-process delegation depth of the current process. */
  depth?: number;
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

export function createAgentRunner(options: RunnerOptions): AgentRunner {
  const depth = options.depth ?? 0;
  return async (call: AgentCall) => {
    const cwd = call.cwd ?? options.cwd;
    const scope = call.scope ?? options.scope ?? "both";
    const agent = resolveAgentOrThrow(call.agent, cwd, scope);

    const { prompt: skillsPrompt } = buildSkillsPrompt(agent.skills, cwd);
    const systemPrompt = [agent.systemPrompt, skillsPrompt]
      .filter(Boolean)
      .join("\n\n");

    const handle = options.engine.spawn({
      agent: agent.name,
      task: call.task,
      cwd,
      systemPrompt: systemPrompt || undefined,
      model: agent.model,
      thinking: agent.thinking,
      tools: agent.tools,
      env: { [DEPTH_ENV_VAR]: String(depth + 1) },
    });

    const onAbort = () => handle.abort();
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener("abort", onAbort, { once: true });

    const progressPump = (async () => {
      for await (const update of handle.updates) {
        call.onProgress?.(update.text);
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
