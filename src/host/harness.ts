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
import type { JsonValue } from "@earendil-works/chord/json";
import type { ClientIdentity, Models, ToolCall } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  defineDoc,
  type EntryId,
  type GenerationCheckpoint,
  GenerationTask,
  Harness,
  type HarnessSettings,
  LiveDoc,
  type Report,
  type Storage,
  ToolTask,
  type ToolTaskCheckpoint,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import {
  type AgentExtensions,
  agentSelection,
  installAgentExtensions,
} from "../agents/extensions.js";
import type { HarnessReport } from "../agents/failures.js";
import { GraphTask, NodeTask } from "../agents/graphs.js";
import type { AgentHooks } from "../hooks.js";
import { ExecutionEnvs } from "./harness-setup.js";
import { AgentRequestHooks } from "./hooks.js";
import { ToolTwin, twinWanted } from "./twin.js";
import { reachForToolCall, type TwinTools } from "./twin-tools.js";

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
    /** How long to wait for a connecting MCP server when needed. */
    startupWaitMs?: number;
  };
}

/**
 * Start the tool twin without waiting for MCP servers: shared extensions
 * load synchronously and MCP servers connect in the background. Without it,
 * agents keep their own tools.
 */
async function openTwin(
  cwd: string,
  options: NonNullable<AgentHarnessOptions["twin"]>,
): Promise<ToolTwin | undefined> {
  let twin: ToolTwin | undefined;
  try {
    twin = await ToolTwin.open({ cwd, ...options });
    return twin;
  } catch (error) {
    await twin?.close().catch(() => {});
    options.onProblem(
      `agents get no MCP or extension tools: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Minimal read-only view of pi-durable's `pi.codemode.run` document to check
 * whether an `execute`-phase codemode task already saved its initial catalog. */
const CodemodeRunSnapshotDoc = defineDoc<{ start?: JsonValue }>({
  kind: "pi.codemode.run",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

/**
 * Wait only for MCP servers reached by unfinished tasks that are about to
 * resume (and for `direct` servers when a generation or graph is resuming), so
 * recovered calls do not fail `tool_unavailable` while healthy opens with
 * no pending MCP work take 0ms.
 */
async function waitForResumedMcp(
  harness: Harness,
  twin: ToolTwin,
  twinTools: TwinTools,
): Promise<void> {
  const servers = twin.mcpServers();
  if (servers.length === 0) return;
  const { tasks, submissions } = await harness.inspect(CONTEXT);
  if (tasks.length === 0 && submissions.length === 0) return;
  const hasDirect = servers.some((server) => server.hasDirect);
  let needsDirect = hasDirect && submissions.length > 0;
  const assistantCalls = new Map<string, ToolCall[]>();
  const loadAssistantCalls = async (
    conversationId: ConversationId,
    assistantId: EntryId,
  ): Promise<ToolCall[]> => {
    const key = `${conversationId}:${assistantId}`;
    const cached = assistantCalls.get(key);
    if (cached !== undefined) return cached;
    const conversation = await harness.conversation(conversationId, CONTEXT);
    const page = conversation
      ? await conversation.entries(
          { minEntryId: assistantId, maxEntryId: assistantId },
          1,
          undefined,
          CONTEXT,
        )
      : undefined;
    const message = page?.items[0]?.model?.[0];
    const calls =
      message?.role === "assistant"
        ? message.content.filter(
            (block): block is ToolCall => block.type === "toolCall",
          )
        : [];
    assistantCalls.set(key, calls);
    return calls;
  };
  const unofferedByConversation = new Map<ConversationId, Set<string>>();
  const loadUnoffered = async (
    conversationId: ConversationId,
  ): Promise<Set<string>> => {
    const cached = unofferedByConversation.get(conversationId);
    if (cached !== undefined) return cached;
    const live = await harness.snapshot(LiveDoc, conversationId, CONTEXT);
    const unoffered = new Set(
      (live?.tools ?? [])
        .filter((slot) => slot.unoffered === true)
        .map((slot) => slot.callId),
    );
    unofferedByConversation.set(conversationId, unoffered);
    return unoffered;
  };
  let needAll = false;
  let needIndirect = false;
  const words = new Set<string>();
  const addCall = (name: string, args: unknown) => {
    const reach = reachForToolCall(name, args);
    if (reach === undefined) return;
    if (reach === "all") {
      needAll = true;
      return;
    }
    if (reach === "indirect") {
      needIndirect = true;
      return;
    }
    for (const word of reach) {
      if (twin.matchedServers([word]).length > 0) words.add(word);
    }
  };
  for (const { record } of tasks) {
    if (record.abortRequested || record.state.status === "completing") continue;
    if (record.kind === ToolTask.definition.name) {
      const input = record.input as Partial<ToolTaskInput> | null;
      // Unoffered calls always settle `tool_unavailable`; never wait for them.
      if (input?.kind === "model" && input.unoffered === true) continue;
      let call: { name: string; arguments: unknown } | undefined;
      if (input?.kind === "nested" && input.call) {
        call = input.call;
      } else if (
        input &&
        typeof (input as { assistant?: unknown }).assistant === "number" &&
        typeof (input as { callId?: unknown }).callId === "string"
      ) {
        const { assistant, callId } = input as {
          assistant: EntryId;
          callId: string;
        };
        call = (
          await loadAssistantCalls(record.conversationId, assistant)
        ).find((item) => item.id === callId);
      }
      if (!call) continue;
      if (call.name === CODEMODE_TOOL_NAME) {
        const checkpoint = record.state
          .checkpoint as Partial<ToolTaskCheckpoint> | null;
        // A codemode call that crashed after committing `execute` but before
        // saving `pi.codemode.run.start` skips `beforeTool` and must build its
        // initial catalog on resume (including any dynamically computed tools).
        // Once `start` is saved, `beforeNestedTool` handles new calls lazily
        // and skips already-settled calls.
        if (checkpoint?.phase === "execute") {
          const run = await harness.snapshot(
            CodemodeRunSnapshotDoc,
            record.id,
            CONTEXT,
          );
          if (run?.start === undefined) needAll = true;
        }
        continue;
      }
      addCall(call.name, call.arguments);
    } else if (
      record.kind === GraphTask.definition.name ||
      record.kind === NodeTask.definition.name
    ) {
      if (hasDirect) needsDirect = true;
    } else if (record.kind === GenerationTask.definition.name) {
      if (hasDirect) needsDirect = true;
      const checkpoint = record.state
        .checkpoint as Partial<GenerationCheckpoint> | null;
      if (
        checkpoint?.phase === "tools" &&
        typeof checkpoint.assistant === "number" &&
        Array.isArray(checkpoint.pending) &&
        checkpoint.pending.length > 0
      ) {
        const pending = new Set(checkpoint.pending);
        const unoffered = await loadUnoffered(record.conversationId);
        for (const call of await loadAssistantCalls(
          record.conversationId,
          checkpoint.assistant,
        ))
          if (pending.has(call.id) && !unoffered.has(call.id))
            addCall(call.name, call.arguments);
      }
    }
  }
  if (!needAll && !needIndirect && words.size === 0 && !needsDirect) return;
  const waits: Array<Promise<void>> = [];
  if (needAll) {
    waits.push(twin.waitFor("all"));
  } else {
    if (needIndirect) waits.push(twin.waitFor("indirect"));
    if (words.size > 0) waits.push(twin.waitFor([...words]));
  }
  if (needsDirect) waits.push(twin.waitForDirect());
  await Promise.all(waits);
  twinTools.sync();
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
  let twin: ToolTwin | undefined;
  // After the harness: work that a tool call waits for ends first.
  const closeTwin = async () => {
    options.extensions.twin.detach();
    await twin?.close();
  };
  try {
    if (
      options.twin &&
      twinWanted(options.cwd, options.twin.extensions, options.twin.trusted)
    )
      twin = await openTwin(options.cwd, options.twin);
    // Before the harness opens, so pre-registered namespaces and shared
    // extension tools are installed in the registry.
    if (twin) options.extensions.twin.connect(twin);
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
    // Wait only for MCP servers reached by unfinished resumed tasks.
    if (twin) await waitForResumedMcp(harness, twin, options.extensions.twin);
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
