import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createSubprocessSpawnEngine,
  formatFailureReason,
  isChildProcessRunning,
  type SpawnProcess,
} from "./engine/subprocess.js";
import { createBackgroundNotificationManager } from "./extension/background-notifications.js";
import {
  registerAgentCommands,
  registerFlowCommands,
} from "./extension/commands.js";
import { createManagedWorkflowExecutor } from "./extension/managed-workflow.js";
import {
  buildAgentSystemPrompt,
  createAgentTool,
  createWorkflowTool,
} from "./extension/tools.js";
import { AgentEvents } from "./runtime/events.js";
import { RunExecutor } from "./runtime/executor.js";
import { LiveRunRegistry } from "./runtime/live-runs.js";
import { AgentManager } from "./runtime/manager.js";
import { RunEventCache } from "./runtime/session-events.js";
import { countStatuses, createRunRuntimeState } from "./runtime/state.js";
import {
  RUN_NOTIFICATION_CUSTOM_TYPE,
  RunWidgetManager,
  rebuildRuntimeState,
  renderRunNotificationMessage,
} from "./ui/presentation.js";

export function createAgentExtension(options?: {
  spawnProcess?: SpawnProcess;
}) {
  const engine = createSubprocessSpawnEngine({
    spawnProcess: options?.spawnProcess,
  });

  return function agentExtension(pi: ExtensionAPI) {
    const runtimeState = createRunRuntimeState();
    const manager = new AgentManager(engine);
    const liveRuns = new LiveRunRegistry();
    const runEventCache = new RunEventCache();
    const widgetManager = new RunWidgetManager(runtimeState);
    const notifications = createBackgroundNotificationManager(pi, runtimeState);
    const executor = new RunExecutor({
      pi,
      manager,
      runtimeState,
      onStateChanged: (ctx) => {
        widgetManager.update(ctx);
        pi.events.emit(
          AgentEvents.RUN_COUNTS_CHANGED,
          countStatuses(runtimeState),
        );
      },
    });
    const executeManagedWorkflow = createManagedWorkflowExecutor({
      pi,
      executor,
      runtimeState,
      liveRuns,
      runEventCache,
      notifications,
    });

    const refreshUi = (ctx: ExtensionContext): void => {
      notifications.setContext(ctx);
      widgetManager.update(ctx);
      notifications.flush(ctx);
    };

    const reloadRunState = (ctx: ExtensionContext): void => {
      notifications.setContext(ctx);
      rebuildRuntimeState(runtimeState, ctx, runEventCache, liveRuns);
      widgetManager.update(ctx);
      notifications.flush(ctx);
    };

    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer(
        RUN_NOTIFICATION_CUSTOM_TYPE,
        renderRunNotificationMessage,
      );
    }

    registerAgentCommands(pi);
    registerFlowCommands(pi, runtimeState, liveRuns);
    pi.registerTool(createAgentTool({ pi, executeManagedWorkflow }));
    pi.registerTool(createWorkflowTool({ pi, executeManagedWorkflow }));

    pi.on("session_start", async (_event, ctx) => {
      reloadRunState(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      reloadRunState(ctx);
    });
    pi.on("session_shutdown", async () => {
      liveRuns.stopAll();
      notifications.clear();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      notifications.setContext(ctx);
      const agentsPrompt = buildAgentSystemPrompt(ctx.cwd);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${agentsPrompt}`,
      };
    });

    pi.on("agent_start", async (_event, ctx) => {
      notifications.setContext(ctx);
    });

    pi.on("tool_execution_end", async (_event, ctx) => {
      refreshUi(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
      refreshUi(ctx);
    });
  };
}

export default createAgentExtension();
export * from "./runtime/events.js";
export { formatFailureReason, isChildProcessRunning, type SpawnProcess };
