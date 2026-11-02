/**
 * pi-agents' behavior as pi-durable extensions, so any registry can install
 * it, the way Pi's session worker installs its coding tools and prompt. A
 * host creates them, installs them in the registry of the harness it opens,
 * and hands the harness to `AgentService`. Every agent names the extensions
 * it selects, so the harness's default selection, such as Pi's own tools
 * and prompt in a session worker, never reaches agents.
 */

import {
  type AgentChange,
  defineExtension,
  type Extension,
  type HookRegistration,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createPromptExtension, type PromptOptions } from "../host/prompt.js";
import { createToolsExtension } from "../host/tools.js";
import { TwinTools } from "../host/twin-tools.js";
import { WorkingAgents } from "../host/working.js";
import { createGraphsExtension } from "./graphs.js";
import { MessagingHub } from "./hub.js";
import {
  createMessagingExtension,
  type MessagingOptions,
} from "./messaging.js";
import { SPAWNING_LIMITS, type SpawningLimits } from "./spawn-support.js";
import { spawningTools } from "./spawning.js";
import type { HelperResolver } from "./types.js";

export interface AgentExtensions {
  /** The tools agents select from. */
  tools: Extension;
  /** The system prompt of agents. */
  prompt: Extension;
  /** Graph and node tasks; they resolve from the registry, and agents never
   * select them. */
  graphs: Extension;
  /** `agent_spawn`, `agent_wait`, and `agent_stop`; only agents that may spawn select it. */
  spawning: Extension;
  /** `agent_send` and `agent_status`; every agent selects it. */
  messaging: Extension;
  /** The tool twin's tools; every agent selects it with all of its tools.
   * The host attaches the twin once it opened. */
  twin: TwinTools;
  /** `tool_search`, which loads the twin's tools that only scripts reach;
   * agents without `codemode` select it. */
  toolSearch: Extension;
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
  /** Tests only: tighter spawning limits. */
  spawningLimits?: Partial<SpawningLimits>;
  messaging?: MessagingOptions;
  /** How many agents work at once; unlimited when absent. */
  maxWorkingAgents?: number;
  /** Co-loaded extensions' hooks on every agent's requests. */
  hooks?: readonly HookRegistration[];
}

export function createAgentExtensions(
  options: AgentExtensionOptions,
): AgentExtensions {
  const twin = new TwinTools();
  const toolSearch = createToolSearchExtension();
  const { extension, close } = createToolsExtension(twin.namespaces);
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
  const limits = { ...SPAWNING_LIMITS, ...options.spawningLimits };
  const pause = working
    ? { pause: (agentId: string) => working.pause(agentId) }
    : {};
  const messaging = createMessagingExtension(hub, options.messaging);
  let spawning: Extension | undefined;
  const spawnTools = spawningTools({
    resolve: options.resolveHelper,
    limits,
    hub,
    ...pause,
    // What a new agent selects besides its own tools.
    selection: (spawn, own = []) => ({
      extensions: [
        tools,
        prompt,
        ...(spawn && spawning ? [spawning] : []),
        messaging,
        twin.extension,
        ...(searchesTools(own, twin) ? [toolSearch] : []),
      ],
      tools: [
        ...(spawn ? (spawning?.tools ?? []) : []),
        ...(messaging.tools ?? []),
      ],
      always: twin.names(),
      filter: (own) => toolFilter(tools, own),
    }),
  });
  spawning = defineExtension({
    name: "pi-agents-spawning",
    tools: spawnTools,
  });
  return {
    tools,
    prompt,
    graphs: createGraphsExtension(),
    spawning,
    messaging,
    twin,
    toolSearch,
    hub,
    ...(working ? { working } : {}),
    close,
  };
}

/**
 * The tool filter of an agent whose own tools are `own`: every tool of the
 * extensions it selects but the agent tools it lacks. The tool twin's
 * tools change as servers connect, so a filter that removes keeps them all.
 */
export function toolFilter(
  tools: Extension,
  own: readonly ToolRegistration[],
): AgentChange["tools"] {
  const names = new Set(own.map((tool) => tool.name));
  return {
    remove: (tools.tools ?? []).filter((tool) => !names.has(tool.name)),
  };
}

/**
 * Whether an agent with `own` tools loads the twin's tools that only
 * scripts reach with `tool_search`: it has no `codemode` to call them.
 * Pi offers MCP tools the same two ways.
 */
export function searchesTools(
  own: readonly ToolRegistration[],
  twin: TwinTools,
): boolean {
  return (
    twin.hasDeferred() && !own.some((tool) => tool.name === CODEMODE_TOOL_NAME)
  );
}

export function installAgentExtensions(
  registry: Registry,
  extensions: AgentExtensions,
): void {
  for (const extension of [
    extensions.tools,
    extensions.prompt,
    extensions.graphs,
    extensions.spawning,
    extensions.messaging,
    extensions.twin.extension,
    extensions.toolSearch,
  ])
    registry.install(extension);
}

/**
 * What an agent selects: its tools and prompt, the spawning tools when it
 * may spawn, and messaging when it may message other agents.
 */
export function agentSelection(
  extensions: AgentExtensions,
  options: { spawn?: boolean; messaging?: boolean; toolSearch?: boolean } = {},
): Extension[] {
  return [
    extensions.tools,
    extensions.prompt,
    ...(options.spawn ? [extensions.spawning] : []),
    ...(options.messaging ? [extensions.messaging] : []),
    extensions.twin.extension,
    ...(options.toolSearch ? [extensions.toolSearch] : []),
  ];
}
