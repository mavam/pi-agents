/**
 * pi-agents extension entry point: keeps delegated processes inert, while the
 * originating process constructs the run infrastructure and registers every
 * orchestration surface.
 */

import { createRequire } from "node:module";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildModelCatalog,
  createModelRefresher,
  resolveModelReference,
} from "./catalog/models.js";
import {
  createSubprocessSpawnEngine,
  DEPTH_ENV_VAR,
} from "./engine/subprocess.js";
import { PromptAppendixCache } from "./presentation/prompt.js";
import { CatalogCache, createProfileAvailability } from "./run/invocation.js";
import {
  getSessionFile,
  isProjectTrusted,
  readRunEvents,
} from "./run/persist.js";
import { createRunEventPublisher, publishReady } from "./run/publish.js";
import { RunManager } from "./run/runs.js";
import {
  registerCommands,
  registerWorkflowCommands,
} from "./triggers/commands.js";
import { HookManager } from "./triggers/hooks.js";
import { RpcManager } from "./triggers/rpc.js";
import {
  createWorkflowInspectTool,
  createWorkflowListTool,
  createWorkflowResultTool,
  createWorkflowStopTool,
} from "./triggers/run-tools.js";
import type { TriggerDeps } from "./triggers/start.js";
import { createWorkflowCreateTool } from "./triggers/tool.js";
import { FocusController } from "./ui/focus.js";
import { FancyFooterRunReporter } from "./ui/footer.js";
import { NotificationManager } from "./ui/notify.js";
import { RunPanel } from "./ui/panel.js";
import {
  MESSAGE_TYPE,
  NOTIFICATION_TYPE,
  registerRenderers,
} from "./ui/render.js";

const PACKAGE_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

function currentDepth(): number {
  const raw = process.env[DEPTH_ENV_VAR];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Register pi-agents only in the originating Pi process. */
export function registerAgentExtension(pi: ExtensionAPI, depth: number): void {
  // Delegated agents are terminal workflow leaves. Their parent interpreter
  // already owns the complete static graph, lifecycle, budget, and result.
  if (depth > 0) return;

  const engine = createSubprocessSpawnEngine();

  // Assigned right below; the manager's callbacks fire only once runs exist.
  let notifications: NotificationManager;
  let widget: RunPanel;
  let footerReporter: FancyFooterRunReporter;

  const manager = new RunManager({
    engine,
    onEvent: (event) => notifications.handleRunEvent(event),
    onStateChanged: () => {
      widget.update();
      footerReporter.update();
    },
    publish: createRunEventPublisher(pi),
  });
  notifications = new NotificationManager(pi, manager);
  widget = new RunPanel(manager);
  footerReporter = new FancyFooterRunReporter(pi, manager);
  const focus = new FocusController(manager, widget);
  // While a user is attached to an agent, nothing may wake the parent
  // session; queued notifications deliver right after detach.
  notifications.setDeliveryGate(() => focus.isPaneOpen());
  focus.onPaneClosed = (ctx) => {
    notifications.setContext(ctx);
    notifications.flush(ctx);
  };

  const deps: TriggerDeps = {
    pi,
    manager,
    notifications,
    widget,
    attach: (ctx, runId, instance) => focus.attach(ctx, runId, instance),
  };
  const refreshModels = createModelRefresher();
  const promptAppendices = new PromptAppendixCache();

  registerRenderers(pi);
  pi.registerTool(createWorkflowCreateTool(deps));
  pi.registerTool(createWorkflowListTool(deps));
  pi.registerTool(createWorkflowInspectTool(deps));
  pi.registerTool(createWorkflowResultTool(deps));
  pi.registerTool(createWorkflowStopTool(deps));
  registerCommands(pi, deps);
  pi.registerShortcut("ctrl+q", {
    description: "Focus the pi-agents run panel",
    handler: (ctx) => focus.focusPanel(ctx),
  });

  const hooks = new HookManager(pi, deps);
  const rpc = new RpcManager(pi, deps, PACKAGE_VERSION);
  rpc.install();

  const refreshUi = (ctx: ExtensionContext): void => {
    notifications.setContext(ctx);
    widget.update(ctx);
    notifications.flush(ctx);
  };

  const reloadRunState = (ctx: ExtensionContext): void => {
    notifications.setContext(ctx);
    manager.absorbHistory(readRunEvents(getSessionFile(ctx)));
    widget.update(ctx);
    footerReporter.update();
    notifications.flush(ctx);
  };

  pi.on("before_agent_start", (event, ctx) => {
    notifications.setContext(ctx);
    refreshModels(ctx.modelRegistry);
    const modelCatalog = buildModelCatalog(ctx.modelRegistry);
    const trusted = isProjectTrusted(ctx);
    const appendix = promptAppendices.get(ctx.cwd, trusted, modelCatalog, () =>
      createProfileAvailability({
        cwd: ctx.cwd,
        scope: trusted ? "both" : "user",
        trusted,
        catalogs: new CatalogCache(),
        resolveModel: (ref) => resolveModelReference(ref, modelCatalog),
      }),
    );
    return {
      systemPrompt: `${event.systemPrompt}\n\n${appendix}`,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    promptAppendices.clear();
    refreshModels(ctx.modelRegistry);
    rpc.setContext(ctx);
    focus.install(ctx);
    reloadRunState(ctx);
    const trusted = isProjectTrusted(ctx);
    registerWorkflowCommands(pi, ctx.cwd, deps, trusted);
    hooks.refresh(ctx.cwd, trusted);
    publishReady(pi, PACKAGE_VERSION);
  });

  pi.on("session_tree", (_event, ctx) => {
    rpc.setContext(ctx);
    reloadRunState(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    notifications.setContext(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    refreshUi(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshUi(ctx);
    // At agent_end the host may still report the session as streaming: the
    // agent loop clears isStreaming only after its run settles, while
    // extension handlers fire from an unawaited event queue that usually
    // runs first. Retry on a macrotask, by which point the run has settled,
    // so queued notifications don't stall until the next user interaction.
    if (notifications.hasPending()) {
      setTimeout(() => notifications.flush(ctx), 0);
    }
  });

  pi.on("session_shutdown", () => {
    rpc.dispose();
    hooks.dispose();
    focus.dispose();
    widget.dispose();
    footerReporter.dispose();
    manager.stopAll();
    notifications.clear();
  });

  // Register hooks after core lifecycle handlers so session context and the
  // ready signal are established before a session_start workflow can run.
  hooks.install();
}

export default function agentExtension(pi: ExtensionAPI): void {
  registerAgentExtension(pi, currentDepth());
}

export { MESSAGE_TYPE, NOTIFICATION_TYPE };
