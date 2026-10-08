/**
 * pi-agents: durable, named agents for Pi, running in-process on pi-durable.
 * This entry point wires the session host, the parent tools, result
 * delivery, and the TUI surfaces.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadModelNotes } from "./catalog/config.js";
import { buildModelCatalog, createModelRefresher } from "./catalog/models.js";
import { registerCommands } from "./pi/commands.js";
import { DeliveryManager } from "./pi/delivery.js";
import { registerMessageRenderers } from "./pi/messages.js";
import { buildSystemPromptAppendix } from "./pi/prompt.js";
import { SessionHost } from "./pi/session.js";
import { scopeOf } from "./pi/spawn.js";
import { registerAgentTools } from "./pi/tools.js";
import { FocusController } from "./ui/focus.js";
import { FancyFooterReporter } from "./ui/footer.js";
import { AgentPanel } from "./ui/panel.js";

export default function agentExtension(pi: ExtensionAPI): void {
  const host = new SessionHost();
  const panel = new AgentPanel(host);
  const focus = new FocusController(host, panel);
  const delivery = new DeliveryManager(pi, host);
  const footer = new FancyFooterReporter(
    pi,
    () => host.current()?.list() ?? [],
  );
  const refreshModels = createModelRefresher();

  // While the user is attached to an agent, nothing wakes the parent.
  delivery.setBlocked(() => focus.isPaneOpen());
  focus.onPaneClosed = (ctx) => delivery.flush(ctx);
  host.subscribe(() => {
    panel.update();
    footer.update();
    delivery.flush();
  });

  registerMessageRenderers(pi);
  registerAgentTools(pi, host);
  registerCommands(pi, { host, panel, focus });
  pi.registerShortcut("ctrl+q", {
    description: "Focus the pi-agents panel",
    handler: (ctx) => focus.focusPanel(ctx),
  });

  const track = (ctx: ExtensionContext): void => {
    host.setContext(ctx);
    delivery.setContext(ctx);
  };

  pi.on("before_agent_start", (event, ctx) => {
    track(ctx);
    refreshModels(ctx.modelRegistry);
    const scope = scopeOf(ctx);
    const appendix = buildSystemPromptAppendix(
      ctx.cwd,
      scope,
      buildModelCatalog(ctx.modelRegistry),
      loadModelNotes(ctx.cwd, scope !== "user"),
    );
    return { systemPrompt: `${event.systemPrompt}\n\n${appendix}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    track(ctx);
    refreshModels(ctx.modelRegistry);
    focus.install(ctx);
    panel.update(ctx);
    await host.start(ctx);
    panel.update(ctx);
    footer.update();
    delivery.flush(ctx);
  });

  pi.on("agent_start", (_event, ctx) => track(ctx));

  pi.on("agent_end", (_event, ctx) => {
    track(ctx);
    // At agent_end Pi may still report streaming; retry on a macrotask, once
    // the run has settled.
    setTimeout(() => delivery.flush(ctx), 0);
  });

  pi.on("session_shutdown", async () => {
    focus.dispose();
    panel.dispose();
    delivery.clear();
    footer.dispose();
    await host.stop();
  });
}
