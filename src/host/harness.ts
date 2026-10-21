/**
 * The host's part of running agents, like the session worker's
 * `createCodingAgentHarness`: open the harness over the storage, with
 * pi-agents' extensions installed, and choose the anchor, the conversation
 * that owns the graphs the parent starts. Inside Pi the anchor is the
 * harness's root conversation, which never runs; Pi's durable session
 * worker would choose the session's main conversation instead. The host
 * starts the core, then resumes the harness.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  Harness,
  type HarnessSettings,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  type AgentExtensions,
  agentSelection,
  installAgentExtensions,
} from "../agents/extensions.js";
import type { AgentHooks } from "../hooks.js";
import { ExecutionEnvs } from "./harness-setup.js";
import { AgentRequestHooks } from "./hooks.js";

const CONTEXT = BACKGROUND_CONTEXT;

export interface AgentHarnessOptions {
  storage: Storage;
  models: Models;
  /** Fallback working directory for agents without one. */
  cwd: string;
  extensions: AgentExtensions;
  settings?: HarnessSettings;
  lifecycle?: { sessionId: string; hooks: readonly AgentHooks[] };
  onReport?: (error: unknown) => void;
}

export interface AgentHarness {
  harness: Harness;
  /** The conversation that owns the parent's graphs. */
  anchor: Conversation;
  /** Close the harness, its environments, and the extensions' scripts,
   * after the service closed. */
  close(): Promise<void>;
}

export async function openAgentHarness(
  options: AgentHarnessOptions,
): Promise<AgentHarness> {
  const registry = createRegistry();
  installAgentExtensions(registry, options.extensions);
  const envs = new ExecutionEnvs(options.cwd);
  const requests = options.lifecycle?.hooks.some((hook) => hook.onAgentRequest)
    ? new AgentRequestHooks(
        options.models,
        options.lifecycle.sessionId,
        options.lifecycle.hooks,
      )
    : undefined;
  let harness: Harness | undefined;
  let unobserve: (() => void) | undefined;
  try {
    harness = await Harness.open(
      options.storage,
      {
        models: requests?.models ?? options.models,
        registry,
        settings: {
          ...options.settings,
          // Agents select their own extensions; the anchor uses this default.
          extensions: agentSelection(options.extensions),
        },
        env: envs.env,
        ...(options.onReport ? { onReport: options.onReport } : {}),
      },
      CONTEXT,
    );
    await requests?.start(harness);
    // Before any work starts, so the cap sees every run end.
    unobserve = options.extensions.working?.observe(harness);
    // The durable root owns the parent's background graphs.
    const anchor = await harness.root(CONTEXT);
    const opened = harness;
    return {
      harness: opened,
      anchor,
      close: async () => {
        try {
          await opened.close(CONTEXT);
        } finally {
          unobserve?.();
          requests?.dispose();
          try {
            await envs.cleanup(CONTEXT);
          } finally {
            await options.extensions.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      await harness?.close(CONTEXT);
    } finally {
      unobserve?.();
      requests?.dispose();
      try {
        await envs.cleanup(CONTEXT);
      } finally {
        await options.extensions.close();
      }
    }
    throw error;
  }
}
