/**
 * Pi trigger adapter for launching runs.
 *
 * Fresh requests enter through `launchTriggeredRun`. It prepares the request,
 * enriches the plan with active-session dependencies, and starts the run.
 * Trigger surfaces never translate a `LaunchPlan` into manager options.
 * Persisted runs use the separate `rerunTriggeredRun` path because their flow
 * is already expanded and validated.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildModelCatalog, resolveModelReference } from "../catalog/models.js";
import type { RunHeader, RunSource } from "../run/events.js";
import {
  type LaunchPlan,
  type LaunchRequest,
  prepareLaunch,
} from "../run/launch.js";
import {
  createOrigin,
  createPersister,
  isProjectTrusted,
} from "../run/persist.js";
import type { SpawnDefaults } from "../run/runner.js";
import type { RunManager, StartedRun } from "../run/runs.js";
import type { NotificationManager } from "../ui/notify.js";
import type { RunPanel } from "../ui/panel.js";

export interface TriggerDeps {
  pi: ExtensionAPI;
  manager: RunManager;
  notifications: NotificationManager;
  widget: RunPanel;
  /** Attach the editor and run panel to one agent. */
  attach?: (ctx: ExtensionContext, runId: string, instance: string) => void;
}

export type TriggerLaunchRequest = Omit<LaunchRequest, "trusted">;

export interface LaunchTriggeredRunOptions {
  request: TriggerLaunchRequest;
  source: RunSource;
  ctx: ExtensionContext;
  /** Move to the background immediately and notify on completion. */
  background: boolean;
}

export interface StartedTriggeredRun extends StartedRun {
  /** The normalized plan, including recoverable launch warnings. */
  plan: LaunchPlan;
}

export interface RerunTriggeredRunOptions {
  header: RunHeader;
  ctx: ExtensionContext;
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

function startPreparedRun(
  deps: TriggerDeps,
  plan: LaunchPlan,
  source: RunSource,
  ctx: ExtensionContext,
  background: boolean,
): StartedRun {
  const origin = createOrigin(ctx);
  const modelCatalog = ctx.modelRegistry
    ? buildModelCatalog(ctx.modelRegistry)
    : undefined;
  const started = deps.manager.start({
    flow: plan.flow,
    cwd: plan.cwd,
    scope: plan.scope,
    label: plan.label,
    display: plan.display,
    warnings: plan.warnings,
    budgets: plan.budgets,
    source,
    originSessionFile: origin.sessionFile,
    defaults: sessionDefaults(deps.pi, ctx),
    resolveModel: modelCatalog
      ? (ref) => resolveModelReference(ref, modelCatalog)
      : undefined,
    trusted: isProjectTrusted(ctx),
    onEvent: createPersister(origin),
  });
  if (background) {
    // Tool-launched runs wake the agent on completion so it can continue its
    // task. Command-, hook-, and RPC-launched runs only display their result.
    deps.notifications.track(
      started.runId,
      origin.sessionFile,
      source.kind === "tool",
    );
    deps.manager.markBackgrounded(started.runId);
    started.done.catch(() => {});
  }
  deps.widget.update(ctx);
  return started;
}

/** Prepare and start one fresh request through the complete trigger contract. */
export function launchTriggeredRun(
  deps: TriggerDeps,
  opts: LaunchTriggeredRunOptions,
): StartedTriggeredRun {
  const plan = prepareLaunch({
    ...opts.request,
    trusted: isProjectTrusted(opts.ctx),
  });
  const source: RunSource = plan.workflowName
    ? { ...opts.source, workflow: plan.workflowName }
    : opts.source;
  return {
    ...startPreparedRun(deps, plan, source, opts.ctx, opts.background),
    plan,
  };
}

/** Start a persisted, already-prepared run without reparsing its expanded flow. */
export function rerunTriggeredRun(
  deps: TriggerDeps,
  opts: RerunTriggeredRunOptions,
): StartedRun {
  const { header } = opts;
  const plan: LaunchPlan = {
    flow: header.flow,
    cwd: header.cwd ?? opts.ctx.cwd,
    scope: header.scope ?? "both",
    label: header.label,
    display: header.display,
    budgets: header.budgets,
    workflowName: header.source.workflow,
    warnings: [...(header.warnings ?? [])],
  };
  return startPreparedRun(deps, plan, header.source, opts.ctx, opts.background);
}
