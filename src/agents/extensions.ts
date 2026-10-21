/**
 * pi-agents' behavior as pi-durable extensions, so any registry can install
 * it, the way Pi's session worker installs its coding tools and prompt. A
 * host creates them, installs them in the registry of the harness it opens,
 * and hands the harness to `AgentService`. Every agent names the extensions
 * it selects, so the harness's default selection, such as Pi's own tools
 * and prompt in a session worker, never reaches agents.
 */

import type {
  Extension,
  HookRegistration,
  Registry,
} from "@earendil-works/pi-durable";
import { createPromptExtension, type PromptOptions } from "../host/prompt.js";
import { createToolsExtension } from "../host/tools.js";
import { WorkingAgents } from "../host/working.js";
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
import { SPAWNING_TOOLS, spawningTools } from "./spawning.js";
import type { HelperResolver } from "./types.js";

export interface AgentExtensions {
  /** The tools agents select from. */
  tools: Extension;
  /** The system prompt of agents. */
  prompt: Extension;
  /** Graph and node tasks; they resolve from the registry, and agents never
   * select them. */
  graphs: Extension;
  /** `agent_spawn`, `agent_wait`, and `agent_stop`, and the legacy
   * `delegate_graph`; only agents that may spawn select it. */
  delegation: Extension;
  /** `agent_send` and `agent_status`; every agent selects it, except
   * helpers of earlier builds' delegation. */
  messaging: Extension;
  /** What the messaging tools share with the service. */
  hub: MessagingHub;
  /** The cap on agents that work at once; the host observes its harness
   * with it. */
  working?: WorkingAgents;
  /** Stop running scripts, after the harness closed. */
  close(): Promise<void>;
}

export interface AgentExtensionOptions {
  prompt: PromptOptions;
  /** Resolves the profiles, models, and skills of helpers. */
  resolveHelper: HelperResolver;
  /** Tests only: tighter delegation limits. */
  delegationLimits?: Partial<DelegationLimits>;
  messaging?: MessagingOptions;
  /** How many agents work at once; unlimited when absent. */
  maxWorkingAgents?: number;
  /** Co-loaded extensions' hooks on every agent's requests. */
  hooks?: readonly HookRegistration[];
}

export function createAgentExtensions(
  options: AgentExtensionOptions,
): AgentExtensions {
  const { extension, close } = createToolsExtension();
  const working =
    options.maxWorkingAgents === undefined
      ? undefined
      : new WorkingAgents(options.maxWorkingAgents);
  // Every agent selects the tools, so their hooks see every request.
  // Extensions' hooks run before the cap's, so a held run takes no slot.
  const hooks = [
    ...(extension.hooks ?? []),
    ...(options.hooks ?? []),
    ...(working?.hooks ?? []),
  ];
  const tools = hooks.length > 0 ? { ...extension, hooks } : extension;
  const prompt = createPromptExtension(options.prompt);
  const hub = new MessagingHub();
  const limits = { ...DELEGATION_LIMITS, ...options.delegationLimits };
  const pause = working
    ? { pause: (agentId: string) => working.pause(agentId) }
    : {};
  const messaging = createMessagingExtension(hub, options.messaging);
  let delegation: Extension | undefined;
  const spawning = spawningTools({
    resolve: options.resolveHelper,
    limits,
    hub,
    ...pause,
    // What a new agent selects besides its own tools.
    selection: (spawn) => ({
      extensions: [
        tools,
        prompt,
        ...(spawn && delegation ? [delegation] : []),
        messaging,
      ],
      tools: [
        ...(spawn
          ? (delegation?.tools ?? []).filter((tool) =>
              (SPAWNING_TOOLS as readonly string[]).includes(tool.name),
            )
          : []),
        ...(messaging.tools ?? []),
      ],
    }),
  });
  delegation = createDelegationExtension(
    {
      resolve: options.resolveHelper,
      limits,
      extensions: [tools, prompt],
      ...pause,
    },
    spawning,
  );
  return {
    tools,
    prompt,
    graphs: createGraphsExtension(),
    delegation,
    messaging,
    hub,
    ...(working ? { working } : {}),
    close,
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
 * What an agent selects: its tools and prompt, the spawning tools when it
 * may spawn, and messaging when it may message other agents. Agents stored
 * before they selected explicitly follow the harness's default, which Pi's
 * host sets to the selection of an agent that doesn't spawn.
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
