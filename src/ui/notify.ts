/**
 * Idle notifications for backgrounded runs: node completions and final
 * results are delivered as custom messages, but only when the originating
 * session is current and idle — otherwise they queue and flush later.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "../run/events.js";
import { getSessionFile, isIdle } from "../run/persist.js";
import type { RunManager } from "../run/runs.js";
import {
  formatUsage,
  formatValuePreview,
  NOTIFICATION_TYPE,
  shortId,
} from "./render.js";

export interface RunNotification {
  kind: "node_update" | "run_final";
  runId: string;
  label?: string;
  status: string;
  text: string;
  at: number;
}

interface TrackedRun {
  originSessionFile?: string;
  /** Bare agent-leaf runs get only the final notification. */
  suppressNodeUpdates: boolean;
  pendingNodeUpdates: RunNotification[];
  pendingFinal?: RunNotification;
}

export class NotificationManager {
  private readonly pi: ExtensionAPI;
  private readonly manager: RunManager;
  private readonly tracked = new Map<string, TrackedRun>();
  private currentContext: ExtensionContext | undefined;

  constructor(pi: ExtensionAPI, manager: RunManager) {
    this.pi = pi;
    this.manager = manager;
  }

  setContext(ctx: ExtensionContext | undefined): void {
    this.currentContext = ctx;
  }

  /** Start delivering notifications for a backgrounded run. */
  track(runId: string, originSessionFile: string | undefined): void {
    const run = this.manager.state.runs.get(runId);
    this.tracked.set(runId, {
      originSessionFile,
      suppressNodeUpdates: run?.header.flow.kind === "agent",
      pendingNodeUpdates: [],
    });
  }

  clear(): void {
    this.tracked.clear();
  }

  /** Feed every run event through here (wired as the manager's onEvent). */
  handleRunEvent(event: RunEvent): void {
    if (event.type === "run_created" || !("runId" in event)) return;
    const tracked = this.tracked.get(event.runId);
    if (!tracked) return;
    const notification = this.buildNotification(event);
    if (!notification) return;
    if (notification.kind === "node_update" && tracked.suppressNodeUpdates)
      return;
    this.deliverOrQueue(event.runId, tracked, notification);
  }

  /** Deliver queued notifications when the origin session is current and idle. */
  flush(ctx?: ExtensionContext): void {
    const context = ctx ?? this.currentContext;
    for (const [runId, tracked] of [...this.tracked.entries()]) {
      if (!this.canDeliver(tracked, context)) continue;
      for (const pending of tracked.pendingNodeUpdates) {
        this.send(pending);
      }
      tracked.pendingNodeUpdates = [];
      if (tracked.pendingFinal) {
        this.send(tracked.pendingFinal);
        this.tracked.delete(runId);
      }
    }
  }

  private buildNotification(event: RunEvent): RunNotification | undefined {
    if (event.type === "node_completed" || event.type === "node_failed") {
      const run = this.manager.state.runs.get(event.runId);
      const node = run?.nodes.get(event.instance);
      if (!run || !node) return undefined;
      if (node.kind !== "agent" && node.kind !== "reduce") return undefined;
      const status = event.type === "node_completed" ? "completed" : "failed";
      const detail =
        event.type === "node_failed"
          ? event.error
          : formatValuePreview(event.value, 200);
      return {
        kind: "node_update",
        runId: event.runId,
        label: run.header.label,
        status,
        at: event.at,
        text: `◦ run ${shortId(event.runId)}${run.header.label ? ` (${run.header.label})` : ""}: ${node.agent ?? node.instance} ${status}${detail ? ` — ${firstLine(detail)}` : ""}`,
      };
    }
    if (event.type === "run_completed") {
      const run = this.manager.state.runs.get(event.runId);
      const summary =
        event.status === "completed"
          ? formatValuePreview(event.value, 600) || "(no output)"
          : (event.error ?? "unknown error");
      const usage = formatUsage(event.usage);
      return {
        kind: "run_final",
        runId: event.runId,
        label: run?.header.label,
        status: event.status,
        at: event.at,
        text: [
          `**Run \`${shortId(event.runId)}\`${run?.header.label ? ` (${run.header.label})` : ""} ${event.status}.**${usage ? ` ${usage}, ${event.agents} agent(s).` : ""}`,
          "",
          summary,
          "",
          `Inspect with \`/run ${shortId(event.runId)}\` · full result: \`/run ${shortId(event.runId)} result\`.`,
        ].join("\n"),
      };
    }
    return undefined;
  }

  private deliverOrQueue(
    runId: string,
    tracked: TrackedRun,
    notification: RunNotification,
  ): void {
    if (this.canDeliver(tracked, this.currentContext)) {
      this.send(notification);
      if (notification.kind === "run_final") this.tracked.delete(runId);
      return;
    }
    if (notification.kind === "run_final") tracked.pendingFinal = notification;
    else tracked.pendingNodeUpdates.push(notification);
  }

  private canDeliver(
    tracked: TrackedRun,
    ctx: ExtensionContext | undefined,
  ): boolean {
    if (!ctx || !isIdle(ctx)) return false;
    if (!tracked.originSessionFile) return true;
    return getSessionFile(ctx) === tracked.originSessionFile;
  }

  private send(notification: RunNotification): void {
    this.pi.sendMessage({
      customType: NOTIFICATION_TYPE,
      content: notification.text,
      display: true,
      details: notification,
    });
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
