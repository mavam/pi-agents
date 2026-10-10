/**
 * pi-agents' behavior as pi-durable extensions, so any registry can install
 * it, the way Pi's session worker installs its coding tools and prompt. A
 * host creates them, installs them in the registry of the harness it opens,
 * and hands the harness to `AgentService`. Every agent names the extensions
 * it selects, so the harness's default selection, such as Pi's own tools
 * and prompt in a session worker, never reaches agents.
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
import { MessagingHub } from "./hub.js";
import {
  createMessagingExtension,
  type MessagingOptions,
} from "./messaging.js";
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
  /** `agent_send`; agents started while messaging is on select it. */
  messaging: Extension;
  /** What the messaging tools share with the service. */
  hub: MessagingHub;
}

export interface AgentExtensionOptions {
  prompt: PromptOptions;
  /** Resolves the profiles, models, and skills of helpers. */
  resolveHelper: HelperResolver;
  /** Tests only: tighter delegation limits. */
  delegationLimits?: Partial<DelegationLimits>;
  messaging?: MessagingOptions;
}

export function createAgentExtensions(
  options: AgentExtensionOptions,
): AgentExtensions {
  const tools = createToolsExtension();
  const prompt = createPromptExtension(options.prompt);
  const hub = new MessagingHub();
  return {
    tools,
    prompt,
    graphs: createGraphsExtension(),
    delegation: createDelegationExtension({
      resolve: options.resolveHelper,
      limits: { ...DELEGATION_LIMITS, ...options.delegationLimits },
      extensions: [tools, prompt],
    }),
    messaging: createMessagingExtension(hub, options.messaging),
    hub,
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
    extensions.messaging,
  ])
    registry.install(extension);
}

/**
 * What an agent selects: its tools and prompt, delegation when it
 * delegates, and messaging when it may message other agents. Agents stored before they selected explicitly follow the
 * harness's default, which Pi's host sets to the selection of an agent that
 * doesn't delegate.
 */
export function agentSelection(
  extensions: AgentExtensions,
  options: { delegate?: boolean; messaging?: boolean } = {},
): Extension[] {
  return [
    extensions.tools,
    extensions.prompt,
    ...(options.delegate ? [extensions.delegation] : []),
    ...(options.messaging ? [extensions.messaging] : []),
  ];
}
