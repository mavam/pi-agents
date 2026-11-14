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
import type { ClientIdentity, Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  Harness,
  type HarnessSettings,
  type Report,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  type AgentExtensions,
  agentSelection,
  installAgentExtensions,
} from "../agents/extensions.js";
import type { HarnessReport } from "../agents/failures.js";
import type { AgentHooks } from "../hooks.js";
import { ExecutionEnvs } from "./harness-setup.js";
import { AgentRequestHooks } from "./hooks.js";
import { ToolTwin, TWIN_STARTUP_WAIT_MS, twinWanted } from "./twin.js";
import { TwinCatalogDoc, type TwinTools } from "./twin-tools.js";

const CONTEXT = BACKGROUND_CONTEXT;

export interface AgentHarnessOptions {
  storage: Storage;
  models: Models;
  /** How model requests of generation, compaction, and tools identify
   * themselves; replaces the identity of `models`. */
  identity: ClientIdentity;
  /** Fallback working directory for agents without one. */
  cwd: string;
  extensions: AgentExtensions;
  settings?: HarnessSettings;
  lifecycle?: { sessionId: string; hooks: readonly AgentHooks[] };
  onReport?: (report: HarnessReport) => void;
  /** Open a tool twin in `cwd` with Pi's MCP and these packages'
   * extensions, whose tools agents get. */
  twin?: {
    extensions: readonly string[];
    /** Whether the session trusts its project. */
    trusted: boolean;
    onProblem: (message: string) => void;
  };
}

/**
 * Start the tool twin in the background. Its tools replace the catalog's
 * stand-ins as they connect, and the stand-ins go once its servers
 * connected or `TWIN_STARTUP_WAIT_MS` passed. Returns how to close it, also
 * while it still starts.
 */
function startTwin(
  cwd: string,
  options: NonNullable<AgentHarnessOptions["twin"]>,
  tools: TwinTools,
): () => Promise<void> {
  const closing = new AbortController();
  const opening = (async (): Promise<ToolTwin | undefined> => {
    let twin: ToolTwin | undefined;
    try {
      twin = await ToolTwin.open({ cwd, ...options });
      if (closing.signal.aborted) {
        await twin.close();
        return undefined;
      }
      tools.connect(twin);
      await twin.ready(TWIN_STARTUP_WAIT_MS, closing.signal);
      return twin;
    } catch (error) {
      await twin?.close().catch(() => {});
      options.onProblem(
        `agents get no MCP or extension tools: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      tools.settle();
    }
  })();
  return async () => {
    closing.abort();
    await (await opening)?.close();
  };
}

/** A harness report as plain data, without pi-durable's types. */
export function plainReport(info: Report): HarnessReport {
  const task =
    "task" in info && info.task
      ? {
          task: {
            id: String(info.task.id),
            kind: info.task.kind,
            conversation: String(info.task.conversationId),
          },
        }
      : {};
  return {
    error: info.error,
    kind: info.kind,
    ...task,
    ...("conversationId" in info && info.conversationId !== undefined
      ? { conversation: String(info.conversationId) }
      : {}),
    ...("extension" in info && info.extension
      ? { extension: info.extension }
      : {}),
    ...("callback" in info ? { callback: info.callback } : {}),
    ...("reason" in info ? { reason: info.reason } : {}),
  };
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
  const tools = options.extensions.twin;
  let stopTwin: (() => Promise<void>) | undefined;
  // After the harness: work that a tool call waits for ends first.
  const closeTwin = async () => {
    tools.detach();
    await stopTwin?.();
  };
  try {
    harness = await Harness.open(
      options.storage,
      {
        models: requests?.models ?? options.models,
        identity: options.identity,
        registry,
        // Read at each use, so getters of the given settings are too.
        settings: () => ({
          ...options.settings,
          // Agents select their own extensions; the anchor uses this default.
          extensions: agentSelection(options.extensions),
        }),
        env: envs.env,
        ...(options.onReport
          ? {
              onReport: (report: Report) =>
                options.onReport?.(plainReport(report)),
            }
          : {}),
      },
      CONTEXT,
    );
    await requests?.start(harness);
    // Before any work starts, so the cap sees every run end.
    unobserve = options.extensions.working?.observe(harness);
    // The durable root owns the parent's background graphs.
    const anchor = await harness.root(CONTEXT);
    // Before the core starts, so tool calls that resume find their tools.
    const twin = options.twin;
    const wanted =
      twin !== undefined &&
      twinWanted(options.cwd, twin.extensions, twin.trusted);
    if (wanted) tools.start();
    tools.restore(
      wanted ? await harness.snapshot(TwinCatalogDoc, CONTEXT) : undefined,
      (catalog) =>
        anchor.commit(async (tx) => {
          (await tx.doc(TwinCatalogDoc)).tools = catalog.tools;
        }, CONTEXT),
      (error) =>
        twin?.onProblem(
          `couldn't store the tool twin's catalog: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
    if (wanted && twin) stopTwin = startTwin(options.cwd, twin, tools);
    else tools.settle();
    const opened = harness;
    return {
      harness: opened,
      anchor,
      close: async () => {
        try {
          // While the harness can still store the catalog.
          await tools.flush();
          await opened.close(CONTEXT);
        } finally {
          unobserve?.();
          requests?.dispose();
          try {
            await envs.cleanup(CONTEXT);
          } finally {
            try {
              await closeTwin();
            } finally {
              await options.extensions.close();
            }
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
        try {
          await closeTwin();
        } finally {
          await options.extensions.close();
        }
      }
    }
    throw error;
  }
}
