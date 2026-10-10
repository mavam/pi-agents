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
import { ExecutionEnvs } from "./harness-setup.js";

const CONTEXT = BACKGROUND_CONTEXT;

export interface AgentHarnessOptions {
  storage: Storage;
  models: Models;
  /** Fallback working directory for agents without one. */
  cwd: string;
  extensions: AgentExtensions;
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
}

export interface AgentHarness {
  harness: Harness;
  /** The conversation that owns the parent's graphs. */
  anchor: Conversation;
  /** Close the harness and its environments, after the service closed. */
  close(): Promise<void>;
}

export async function openAgentHarness(
  options: AgentHarnessOptions,
): Promise<AgentHarness> {
  const registry = createRegistry();
  installAgentExtensions(registry, options.extensions);
  const envs = new ExecutionEnvs(options.cwd);
  let harness: Harness | undefined;
  try {
    harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        settings: {
          ...options.settings,
          // New agents name their extensions; agents stored by earlier
          // versions name none and follow this default.
          extensions: agentSelection(options.extensions),
        },
        env: envs.env,
        ...(options.onReport ? { onReport: options.onReport } : {}),
      },
      CONTEXT,
    );
    // Sessions stored by earlier versions anchor their graphs here too.
    const anchor = await harness.root(CONTEXT);
    const opened = harness;
    return {
      harness: opened,
      anchor,
      close: async () => {
        await opened.close(CONTEXT);
        await envs.cleanup(CONTEXT);
      },
    };
  } catch (error) {
    await harness?.close(CONTEXT);
    await envs.cleanup(CONTEXT);
    throw error;
  }
}
