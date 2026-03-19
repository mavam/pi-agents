import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Thinking } from "../catalog/agents.js";
import type { RunExecutor } from "../runtime/executor.js";
import type { LiveRunRegistry } from "../runtime/live-runs.js";
import { RUN_EVENT_CUSTOM_TYPE } from "../runtime/persistence.js";
import type { RunEventCache } from "../runtime/session-events.js";
import { getRunSnapshot, type RunRuntimeState } from "../runtime/state.js";
import type {
  RunEvent,
  RunResultDetails,
  WorkflowParams,
} from "../runtime/types.js";
import type { BackgroundNotificationManager } from "./background-notifications.js";
import { formatWorkflowProgressText } from "./tool-helpers.js";

export type ManagedWorkflowExecutor = (
  workflowParams: WorkflowParams,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: ((result: AgentToolResult<RunResultDetails>) => void) | undefined,
  defaults: { model?: string; thinking?: Thinking },
  options?: { backgroundImmediately?: boolean },
) => Promise<RunResultDetails>;

export function createManagedWorkflowExecutor(options: {
  pi: ExtensionAPI;
  executor: RunExecutor;
  runtimeState: RunRuntimeState;
  liveRuns: LiveRunRegistry;
  runEventCache: RunEventCache;
  notifications: BackgroundNotificationManager;
}): ManagedWorkflowExecutor {
  const { pi, executor, runtimeState, liveRuns, runEventCache, notifications } =
    options;

  return async function executeManagedWorkflow(
    workflowParams,
    ctx,
    signal,
    onUpdate,
    defaults,
    runOptions,
  ) {
    notifications.setContext(ctx);
    if (signal?.aborted) {
      return await executor.execute(
        workflowParams,
        ctx,
        signal,
        onUpdate,
        defaults,
      );
    }

    const backgroundController = new AbortController();
    const origin = runEventCache.createOrigin(ctx.sessionManager);
    let runId: string | undefined;
    let latestSnapshot: RunResultDetails | undefined;
    let backgrounded = false;
    let backgroundAfterCreate = runOptions?.backgroundImmediately === true;
    let settled = false;
    let resolveBackground: ((details: RunResultDetails) => void) | undefined;
    let rejectBackground: ((error: Error) => void) | undefined;

    const emitWorkflowUpdate = (snapshot: RunResultDetails): void => {
      latestSnapshot = structuredClone(snapshot);
      if (!onUpdate || backgrounded) return;
      onUpdate({
        content: [
          {
            type: "text",
            text: formatWorkflowProgressText(snapshot),
          },
        ],
        details: structuredClone(snapshot),
      });
    };

    const backgroundPromise = new Promise<RunResultDetails>(
      (resolve, reject) => {
        resolveBackground = resolve;
        rejectBackground = reject;
      },
    );

    const persistEvent = (event: RunEvent) => {
      if (!runEventCache.appendToOrigin(origin, event)) {
        pi.appendEntry(RUN_EVENT_CUSTOM_TYPE, event);
      }
    };

    const moveToBackground = () => {
      if (settled || backgrounded) return;
      if (!runId) {
        backgroundAfterCreate = true;
        return;
      }
      backgrounded = true;
      notifications.startTracking(runId, {
        originSessionFile: origin.sessionFile,
      });
      executor.markBackgrounded(runId, ctx, {
        appendEvent: persistEvent,
      });
      const snapshot = getRunSnapshot(runtimeState, runId);
      if (snapshot) {
        latestSnapshot = snapshot;
        resolveBackground?.(snapshot);
      } else {
        rejectBackground?.(new Error("Workflow aborted."));
      }
    };

    const onAbort = () => {
      if (settled) return;
      if (!runId) {
        backgroundController.abort();
        rejectBackground?.(new Error("Workflow aborted."));
        return;
      }
      moveToBackground();
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const liveUpdateInterval = onUpdate
      ? setInterval(() => {
          const snapshot = latestSnapshot;
          if (
            !snapshot ||
            backgrounded ||
            settled ||
            snapshot.run.status !== "running"
          ) {
            return;
          }
          emitWorkflowUpdate(snapshot);
        }, 200)
      : undefined;
    liveUpdateInterval?.unref?.();

    const executionPromise = executor
      .execute(
        workflowParams,
        ctx,
        backgroundController.signal,
        backgrounded
          ? undefined
          : onUpdate
            ? (update) => {
                emitWorkflowUpdate(update.details);
              }
            : undefined,
        defaults,
        {
          appendEvent: persistEvent,
          onRunCreated: (createdRunId) => {
            runId = createdRunId;
            latestSnapshot = getRunSnapshot(runtimeState, createdRunId);
            liveRuns.register({
              runId: createdRunId,
              sessionFile: origin.sessionFile,
              stop: () => backgroundController.abort(),
              snapshot: () =>
                latestSnapshot ? structuredClone(latestSnapshot) : undefined,
            });
            if (backgroundAfterCreate) {
              moveToBackground();
            }
          },
          onEvent: (event) => {
            if (runId) {
              const snapshot = getRunSnapshot(runtimeState, runId);
              if (snapshot) latestSnapshot = snapshot;
            }
            if (!backgrounded || !runId) return;
            notifications.handleRunEvent(runId, event, ctx);
          },
        },
      )
      .finally(() => {
        settled = true;
        if (liveUpdateInterval) clearInterval(liveUpdateInterval);
        if (runId) liveRuns.remove(runId);
      });

    try {
      return await Promise.race([executionPromise, backgroundPromise]);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}
