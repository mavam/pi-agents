/**
 * pi-agents' behavior as pi-durable extensions, so any registry can install
 * it, the way Pi's session worker installs its coding tools and prompt. A
 * host creates them, installs them in the registry of the harness it opens,
 * selects `agentSelection` by default, and hands the harness to
 * `AgentService`.
 */

import type { Extension, Registry } from "@earendil-works/pi-durable";
import { createPromptExtension, type PromptOptions } from "../host/prompt.js";
import { createToolsExtension } from "../host/tools.js";
import {
  createDelegationExtension,
  DELEGATION_LIMITS,
  type DelegationLimits,
} from "./delegation.js";
import { createGraphsExtension } from "./graphs.js";
import type { HelperResolver } from "./types.js";

export interface AgentExtensions {
  /** The tools agents select from. */
  tools: Extension;
  /** The system prompt of agents. */
  prompt: Extension;
  /** Graph and node tasks; they resolve from the registry, and agents never
   * select them. */
  graphs: Extension;
  /** `delegate_graph`; only delegating agents select it. */
  delegation: Extension;
}

export interface AgentExtensionOptions {
  prompt: PromptOptions;
  /** Resolves the profiles, models, and skills of helpers. */
  resolveHelper: HelperResolver;
  /** Tests only: tighter delegation limits. */
  delegationLimits?: Partial<DelegationLimits>;
}

export function createAgentExtensions(
  options: AgentExtensionOptions,
): AgentExtensions {
  return {
    tools: createToolsExtension(),
    prompt: createPromptExtension(options.prompt),
    graphs: createGraphsExtension(),
    delegation: createDelegationExtension({
      resolve: options.resolveHelper,
      limits: { ...DELEGATION_LIMITS, ...options.delegationLimits },
    }),
  };
}

export function installAgentExtensions(
  registry: Registry,
  extensions: AgentExtensions,
): void {
  for (const extension of [
    extensions.tools,
    extensions.prompt,
    extensions.graphs,
    extensions.delegation,
  ])
    registry.install(extension);
}

/** What agents select unless configured otherwise: their tools and prompt. */
export function agentSelection(extensions: AgentExtensions): Extension[] {
  return [extensions.tools, extensions.prompt];
}
