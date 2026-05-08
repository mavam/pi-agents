import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getRunSnapshot, type RunRuntimeState } from "../runtime/state.js";
import type { RunEvent, RunNotificationDetails } from "../runtime/types.js";
import {
  formatRunNotificationContent,
  RUN_NOTIFICATION_CUSTOM_TYPE,
} from "../ui/presentation.js";
import { getSessionFile, isIdle } from "./context.js";
import {
  isSingleSpawnFlow,
  summarizeFinalNotification,
} from "./tool-helpers.js";

interface BackgroundNotificationState {
  originSessionFile?: string;
  suppressSpawnUpdates?: boolean;
  pendingSpawnUpdates: RunNotificationDetails[];
  pendingFinal?: RunNotificationDetails;
}

export interface BackgroundNotificationManager {
  setContext(ctx: ExtensionContext | undefined): void;
  startTracking(
    runId: string,
    options: Omit<
      BackgroundNotificationState,
      "pendingSpawnUpdates" | "pendingFinal"
    >,
  ): void;
  flush(ctx?: ExtensionContext): void;
  handleRunEvent(runId: string, event: RunEvent, ctx: ExtensionContext): void;
  clear(): void;
}

export function createBackgroundNotificationManager(
  pi: ExtensionAPI,
  runtimeState: RunRuntimeState,
): BackgroundNotificationManager {
  const backgroundNotifications = new Map<
    string,
    BackgroundNotificationState
  >();
  let currentContext: ExtensionContext | undefined;

  const sendNotification = (details: RunNotificationDetails): void => {
    pi.sendMessage({
      customType: RUN_NOTIFICATION_CUSTOM_TYPE,
      content: formatRunNotificationContent(details),
      display: true,
      details,
    });
  };

  const canDeliverToOriginSession = (
    notificationState: Pick<BackgroundNotificationState, "originSessionFile">,
    ctx: ExtensionContext | undefined,
  ): boolean => {
    if (!ctx || !isIdle(ctx)) return false;
    if (!notificationState.originSessionFile) return true;
    return getSessionFile(ctx) === notificationState.originSessionFile;
  };

  const buildSpawnNotification = (
    event: Extract<RunEvent, { type: "node_completed" | "node_stopped" }>,
  ): RunNotificationDetails | undefined => {
    const node = runtimeState.nodes.get(event.nodeId);
    if (!node || node.kind !== "spawn") return undefined;

    const run = runtimeState.runs.get(event.runId);
    if (!run) return undefined;
    if (isSingleSpawnFlow(run.flow)) return undefined;

    const output =
      typeof node.output === "object" && node.output !== null
        ? (node.output as Record<string, unknown>)
        : undefined;
    const agent = typeof output?.agent === "string" ? output.agent : undefined;
    const summary =
      typeof node.output === "string"
        ? node.output
        : typeof output?.output === "string"
          ? output.output
          : undefined;

    return {
      kind: "spawn_update",
      runId: run.id,
      runLabel: run.label,
      status: event.type === "node_completed" ? "completed" : "stopped",
      nodeId: node.id,
      nodeLabel: node.label ?? agent ?? node.id,
      agent,
      summary,
      error: event.type === "node_stopped" ? node.error : undefined,
      timestamp: event.at,
    };
  };

  const buildFinalNotification = (
    event: Extract<RunEvent, { type: "run_completed" }>,
  ): RunNotificationDetails | undefined => {
    const snapshot = getRunSnapshot(runtimeState, event.runId);
    if (!snapshot || snapshot.run.status === "running") return undefined;

    return {
      kind: "run_final",
      runId: snapshot.run.id,
      runLabel: snapshot.run.label,
      status: snapshot.run.status,
      summary: summarizeFinalNotification(snapshot.result),
      error: snapshot.run.error,
      timestamp: event.at,
    };
  };

  const queueBackgroundNotification = (
    runId: string,
    details: RunNotificationDetails,
    ctx: ExtensionContext,
  ): void => {
    const notificationState = backgroundNotifications.get(runId);
    if (!notificationState) return;
    if (
      details.kind === "spawn_update" &&
      notificationState.suppressSpawnUpdates
    ) {
      return;
    }

    const deliveryCtx = currentContext ?? ctx;
    if (canDeliverToOriginSession(notificationState, deliveryCtx)) {
      sendNotification(details);
      if (details.kind === "run_final") {
        backgroundNotifications.delete(runId);
      }
      return;
    }

    if (details.kind === "run_final") {
      if (
        notificationState.originSessionFile &&
        getSessionFile(deliveryCtx) !== notificationState.originSessionFile
      ) {
        notificationState.pendingSpawnUpdates = [];
      }
      notificationState.pendingFinal = details;
      return;
    }

    if (
      !notificationState.originSessionFile ||
      getSessionFile(deliveryCtx) === notificationState.originSessionFile
    ) {
      notificationState.pendingSpawnUpdates.push(details);
    }
  };

  return {
    setContext(ctx) {
      currentContext = ctx;
    },

    startTracking(runId, options) {
      backgroundNotifications.set(runId, {
        ...options,
        pendingSpawnUpdates: [],
      });
    },

    flush(ctx = currentContext) {
      if (ctx) currentContext = ctx;
      const activeSessionFile = getSessionFile(ctx);

      for (const [runId, notificationState] of backgroundNotifications) {
        if (
          notificationState.originSessionFile &&
          activeSessionFile !== notificationState.originSessionFile
        ) {
          notificationState.pendingSpawnUpdates = [];
          continue;
        }
        if (!canDeliverToOriginSession(notificationState, ctx)) {
          continue;
        }

        for (const update of notificationState.pendingSpawnUpdates) {
          sendNotification(update);
        }
        notificationState.pendingSpawnUpdates = [];

        if (notificationState.pendingFinal) {
          sendNotification(notificationState.pendingFinal);
          backgroundNotifications.delete(runId);
        }
      }
    },

    handleRunEvent(runId, event, ctx) {
      if (!backgroundNotifications.has(runId)) return;
      currentContext ??= ctx;

      switch (event.type) {
        case "node_completed":
        case "node_stopped": {
          const details = buildSpawnNotification(event);
          if (details) queueBackgroundNotification(runId, details, ctx);
          break;
        }
        case "run_completed": {
          const details = buildFinalNotification(event);
          if (details) queueBackgroundNotification(runId, details, ctx);
          break;
        }
        default:
          break;
      }
    },

    clear() {
      backgroundNotifications.clear();
    },
  };
}
