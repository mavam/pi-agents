/**
 * Shared run-start path for all three trigger surfaces (tool, slash command,
 * event hook): creates the persistence origin, starts the run, and handles
 * background bookkeeping (notification tracking + widget refresh).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Budgets, FlowNode, Scope } from "../model/ast.js";
import type { RunSource } from "../run/events.js";
import { createPersister, type RunEventCache } from "../run/persist.js";
import type { RunManager, StartedRun } from "../run/runs.js";
import type { NotificationManager } from "../ui/notify.js";
import type { RunWidget } from "../ui/widget.js";

export interface TriggerDeps {
  pi: ExtensionAPI;
  manager: RunManager;
  cache: RunEventCache;
  notifications: NotificationManager;
  widget: RunWidget;
}

export interface StartTriggeredRunOptions {
  flow: FlowNode;
  cwd: string;
  scope?: Scope;
  label?: string;
  budgets?: Budgets;
  source: RunSource;
  ctx: ExtensionContext;
  /** Move to background immediately (notifications deliver the result). */
  background: boolean;
}

export function startTriggeredRun(
  deps: TriggerDeps,
  opts: StartTriggeredRunOptions,
): StartedRun {
  const origin = deps.cache.createOrigin(opts.ctx.sessionManager);
  const persist = createPersister(deps.pi, deps.cache, origin);
  const started = deps.manager.start({
    flow: opts.flow,
    cwd: opts.cwd,
    scope: opts.scope,
    label: opts.label,
    budgets: opts.budgets,
    source: opts.source,
    originSessionFile: origin.sessionFile,
    onEvent: persist,
  });
  if (opts.background) {
    deps.notifications.track(started.runId, origin.sessionFile);
    deps.manager.markBackgrounded(started.runId);
    started.done.catch(() => {});
  }
  deps.widget.update(opts.ctx);
  return started;
}
