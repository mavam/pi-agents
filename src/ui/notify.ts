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
import { truncateModelResult, valueText } from "../model/value.js";
import type { RunEvent } from "../run/events.js";
import { getSessionFile, isIdle } from "../run/persist.js";
import type { RunManager } from "../run/runs.js";
import {
  formatAgentCount,
  formatRunNotificationControls,
  formatUsage,
  NOTIFICATION_TYPE,
  type RunNotificationDetails,
  renderResultValue,
  selectDisplayValue,
  shortId,
} from "./render.js";
import { STATUS_STYLES } from "./status.js";

export type RunNotification = RunNotificationDetails & {
  /** Model-facing body, kept separate from the TUI presentation. */
  modelBody?: string;
};

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
    const notification = this.buildNotification(event);
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

  private buildNotification(event: RunEvent): RunNotification | undefined {
    if (event.type !== "run_completed") return undefined;

    const run = this.manager.state.runs.get(event.runId);
    const label = run
      ? (run.header.label ?? run.header.source.workflow ?? run.header.flow.kind)
      : undefined;
    const usage = formatUsage(event.usage) || undefined;
    if (event.status === "completed") {
      const result = valueText(event.value) ?? "";
      const display = selectDisplayValue(event.value, run?.header.display);
      const presented = valueText(display.value) ?? "";
      return {
        kind: "run_final",
        version: 2,
        runId: event.runId,
        label,
        status: event.status,
        usage,
        agents: event.agents,
        bodyKind: "result",
        body: presented
          ? renderResultValue(display.value, presented)
          : "(no output)",
        modelBody: result
          ? renderResultValue(
              event.value,
              truncateModelResult(
                result,
                `/workflow ${shortId(event.runId)} raw`,
              ),
            )
          : undefined,
        at: event.at,
      };
    }
    if (event.status === "failed") {
      return {
        kind: "run_final",
        version: 2,
        runId: event.runId,
        label,
        status: event.status,
        usage,
        agents: event.agents,
        bodyKind: "error",
        body: event.error ?? "unknown error",
        at: event.at,
      };
    }
    return {
      kind: "run_final",
      version: 2,
      runId: event.runId,
      label,
      status: event.status,
      usage,
      agents: event.agents,
      bodyKind: "none",
      at: event.at,
    };
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
    const { modelBody: _modelBody, ...details } = notification;
    this.pi.sendMessage(
      {
        customType: NOTIFICATION_TYPE,
        content: this.content(notification, wake),
        display: true,
        details,
      },
      wake ? { triggerTurn: true } : undefined,
    );
  }

  /** Model-facing Markdown. The dedicated TUI renderer uses structured
   * details and intentionally leaves out the continuation instruction. */
  private content(notification: RunNotification, wake: boolean): string {
    const id = shortId(notification.runId);
    const status = STATUS_STYLES[notification.status];
    const identity = notification.label
      ? `**${escapeMarkdown(notification.label)}** · \`${id}\``
      : `\`${id}\``;
    const usage = notification.usage
      ? ` · ${notification.usage} · ${formatAgentCount(notification.agents)}`
      : "";
    const lines = [
      `❖ ${identity} · ${status.icon} ${notification.status}${usage}`,
    ];
    if (wake) lines.push("", "Continue your task using this result.");
    if (notification.bodyKind !== "none" && notification.body !== undefined) {
      lines.push("", notification.modelBody ?? notification.body);
    }
    lines.push("", formatRunNotificationControls(notification.runId));
    return lines.join("\n");
  }
}

/** Keep a user-provided label inside the notification's bold Markdown span. */
function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*");
}
