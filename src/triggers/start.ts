/**
 * Shared run-start path for every trigger surface (tool, slash command, event
 * hook, RPC): creates the sidecar persistence origin, captures session defaults
 * (model/thinking), starts the run, and handles background bookkeeping
 * (notification tracking + widget refresh).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Budgets, FlowNode, Scope } from "../model/ast.js";
import type { RunSource } from "../run/events.js";
import {
  createOrigin,
  createPersister,
  isProjectTrusted,
} from "../run/persist.js";
import type { SpawnDefaults } from "../run/runner.js";
import type { RunManager, StartedRun } from "../run/runs.js";
import type { NotificationManager } from "../ui/notify.js";
import type { RunWidget } from "../ui/widget.js";

export interface TriggerDeps {
  pi: ExtensionAPI;
  manager: RunManager;
  notifications: NotificationManager;
  widget: RunWidget;
}

export interface StartTriggeredRunOptions {
  flow: FlowNode;
  cwd: string;
  scope?: Scope;
  label?: string;
  /** Saved-workflow result path selected for human-facing rendering. */
  display?: string;
  budgets?: Budgets;
  source: RunSource;
  ctx: ExtensionContext;
  /** Move to background immediately (notifications deliver the result). */
  background: boolean;
}

/** Agents without explicit frontmatter inherit the active session settings. */
function sessionDefaults(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): SpawnDefaults {
  return {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking:
      typeof pi.getThinkingLevel === "function"
        ? pi.getThinkingLevel()
        : undefined,
  };
}

export function startTriggeredRun(
  deps: TriggerDeps,
  opts: StartTriggeredRunOptions,
): StartedRun {
  const origin = createOrigin(opts.ctx);
  const started = deps.manager.start({
    flow: opts.flow,
    cwd: opts.cwd,
    scope: opts.scope,
    label: opts.label,
    display: opts.display,
    budgets: opts.budgets,
    source: opts.source,
    originSessionFile: origin.sessionFile,
    defaults: sessionDefaults(deps.pi, opts.ctx),
    trusted: isProjectTrusted(opts.ctx),
    onEvent: createPersister(origin),
  });
  if (opts.background) {
    // Tool-launched runs wake the agent on completion so it can continue its
    // task; command- and hook-launched runs only display their result.
    deps.notifications.track(
      started.runId,
      origin.sessionFile,
      opts.source.kind === "tool",
    );
    deps.manager.markBackgrounded(started.runId);
    started.done.catch(() => {});
  }
  deps.widget.update(opts.ctx);
  return started;
}
