/**
 * Idle notifications for backgrounded runs: one final-result message per
 * run, delivered when the originating session is current and idle —
 * otherwise queued and flushed later. Per-node progress never notifies;
 * the live widget carries it.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "../run/events.js";
import { getSessionFile, isIdle } from "../run/persist.js";
import type { RunManager } from "../run/runs.js";
import {
  fenced,
  formatUsage,
  formatValuePreview,
  NOTIFICATION_TYPE,
  shortId,
} from "./render.js";

export interface RunNotification {
  kind: "run_final";
  runId: string;
  label?: string;
  status: string;
  text: string;
  at: number;
}

interface TrackedRun {
  originSessionFile?: string;
  /** Trigger a new agent turn on delivery (tool-launched runs). */
  wake: boolean;
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

  /** Start delivering the final notification for a backgrounded run. */
  track(
    runId: string,
    originSessionFile: string | undefined,
    wake: boolean,
  ): void {
    this.tracked.set(runId, { originSessionFile, wake });
  }

  clear(): void {
    this.tracked.clear();
  }

  /** Feed every run event through here (wired as the manager's onEvent). */
  handleRunEvent(event: RunEvent): void {
    if (event.type === "run_created" || !("runId" in event)) return;
    const tracked = this.tracked.get(event.runId);
    if (!tracked) return;
    const notification = this.buildNotification(event, tracked.wake);
    if (!notification) return;
    this.deliverOrQueue(event.runId, tracked, notification);
  }

  /** Whether any tracked run has a queued, undelivered final notification. */
  hasPending(): boolean {
    for (const tracked of this.tracked.values()) {
      if (tracked.pendingFinal) return true;
    }
    return false;
  }

  /** Deliver queued notifications when the origin session is current and idle. */
  flush(ctx?: ExtensionContext): void {
    const context = ctx ?? this.currentContext;
    for (const [runId, tracked] of [...this.tracked.entries()]) {
      if (!this.canDeliver(tracked, context)) continue;
      if (tracked.pendingFinal) {
        this.send(tracked.pendingFinal, tracked.wake);
        this.tracked.delete(runId);
      }
    }
  }

  private buildNotification(
    event: RunEvent,
    wake: boolean,
  ): RunNotification | undefined {
    if (event.type === "run_completed") {
      const run = this.manager.state.runs.get(event.runId);
      // Fence the value preview: raw JSON/text would be reflowed (and
      // mangled) by the markdown renderer.
      const preview =
        event.status === "completed"
          ? formatValuePreview(event.value, 600)
          : "";
      const summary =
        event.status === "completed"
          ? preview
            ? fenced(preview)
            : "(no output)"
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
          ...(wake ? ["", "Continue your task using this result."] : []),
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
      this.send(notification, tracked.wake);
      this.tracked.delete(runId);
      return;
    }
    tracked.pendingFinal = notification;
  }

  private canDeliver(
    tracked: TrackedRun,
    ctx: ExtensionContext | undefined,
  ): boolean {
    if (!ctx || !isIdle(ctx)) return false;
    if (!tracked.originSessionFile) return true;
    return getSessionFile(ctx) === tracked.originSessionFile;
  }

  // Delivery is gated on an idle session, so `triggerTurn` always hits the
  // "not streaming → start new turn" branch of the host API.
  private send(notification: RunNotification, wake: boolean): void {
    this.pi.sendMessage(
      {
        customType: NOTIFICATION_TYPE,
        content: notification.text,
        display: true,
        details: notification,
      },
      wake ? { triggerTurn: true } : undefined,
    );
  }
}
