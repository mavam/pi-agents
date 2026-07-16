/**
 * pi-agents extension entry point: constructs the engine, run manager, and
 * UI managers; registers the workflow tool, slash commands, event hooks, and
 * the system-prompt catalogs; and rebuilds run history from session entries.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPromptAppendix } from "./catalog/prompt.js";
import {
  createSubprocessSpawnEngine,
  DEPTH_ENV_VAR,
} from "./engine/subprocess.js";
import { extractRunEvents, RunEventCache } from "./run/persist.js";
import { RunManager } from "./run/runs.js";
import {
  registerCommands,
  registerWorkflowCommands,
} from "./triggers/commands.js";
import { HookManager } from "./triggers/hooks.js";
import type { TriggerDeps } from "./triggers/start.js";
import { createWorkflowTool } from "./triggers/tool.js";
import { NotificationManager } from "./ui/notify.js";
import {
  MESSAGE_TYPE,
  NOTIFICATION_TYPE,
  registerRenderers,
} from "./ui/render.js";
import { RunWidget } from "./ui/widget.js";

function currentDepth(): number {
  const raw = process.env[DEPTH_ENV_VAR];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default function agentExtension(pi: ExtensionAPI): void {
  const engine = createSubprocessSpawnEngine();
  const cache = new RunEventCache();

  // Assigned right below; the manager's callbacks fire only once runs exist.
  let notifications: NotificationManager;
  let widget: RunWidget;

  const manager = new RunManager({
    engine,
    depth: currentDepth(),
    onEvent: (event) => notifications.handleRunEvent(event),
    onStateChanged: () => widget.update(),
  });
  notifications = new NotificationManager(pi, manager);
  widget = new RunWidget(manager);

  const deps: TriggerDeps = { pi, manager, cache, notifications, widget };

  registerRenderers(pi);
  pi.registerTool(createWorkflowTool(deps));
  registerCommands(pi, deps);

  const hooks = new HookManager(pi, deps);
  hooks.install();

  const refreshUi = (ctx: ExtensionContext): void => {
    notifications.setContext(ctx);
    widget.update(ctx);
    notifications.flush(ctx);
  };

  const reloadRunState = (ctx: ExtensionContext): void => {
    notifications.setContext(ctx);
    const sessionManager = ctx.sessionManager;
    const entries =
      typeof sessionManager?.getBranch === "function"
        ? sessionManager.getBranch()
        : [];
    const sessionFile =
      typeof sessionManager?.getSessionFile === "function"
        ? sessionManager.getSessionFile()
        : undefined;
    manager.absorbHistory(
      extractRunEvents(cache.mergeEntries(sessionFile, entries)),
    );
    widget.update(ctx);
    notifications.flush(ctx);
  };

  pi.on("before_agent_start", (event, ctx) => {
    notifications.setContext(ctx);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAppendix(ctx.cwd)}`,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    reloadRunState(ctx);
    registerWorkflowCommands(pi, ctx.cwd, deps);
    hooks.refresh(ctx.cwd);
  });

  pi.on("session_tree", (_event, ctx) => {
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
  });

  pi.on("session_shutdown", () => {
    manager.stopAll();
    notifications.clear();
  });
}

export { MESSAGE_TYPE, NOTIFICATION_TYPE };
