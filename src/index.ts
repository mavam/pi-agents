/**
 * pi-agents: durable, named agents for Pi, running in-process on pi-durable.
 * This entry point wires the session host, the parent tools, result
 * delivery, and the TUI surfaces.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./pi/commands.js";
import { DeliveryManager } from "./pi/delivery.js";
import { registerMessageRenderers } from "./pi/messages.js";
import { buildSystemPromptAppendix, profileCatalog } from "./pi/prompt.js";
import { SessionHost } from "./pi/session.js";
import { scopeOf } from "./pi/spawn.js";
import { SteerWatch } from "./pi/steering.js";
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

  // While the user is attached to an agent, nothing wakes the parent.
  delivery.setBlocked(() => focus.isPaneOpen());
  focus.onPaneClosed = (ctx) => delivery.flush(ctx);
  host.subscribe(() => {
    panel.update();
    footer.update();
    delivery.flush();
  });

  registerMessageRenderers(pi);
  // A steer ends waits for agents, so Pi doesn't hold it back.
  const steering = new SteerWatch();
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") steering.steer();
    return { action: "continue" };
  });
  registerAgentTools(pi, host, steering);
  registerCommands(pi, { host, panel, focus });
  pi.registerShortcut("ctrl+q", {
    description: "Focus the pi-agents panel",
    handler: (ctx) => focus.focusPanel(ctx),
  });

  const track = (ctx: ExtensionContext): void => {
    host.setContext(ctx);
    delivery.setContext(ctx);
  };

  // Profile problems are reported once per session, not on every turn.
  const reported = new Set<string>();
  pi.on("before_agent_start", (event, ctx) => {
    track(ctx);
    const scope = scopeOf(ctx);
    const { profiles, issues } = profileCatalog(
      ctx.cwd,
      scope,
      ctx.modelRegistry.getAvailable(),
    );
    const fresh = issues.filter((issue) => !reported.has(issue));
    for (const issue of fresh) reported.add(issue);
    if (fresh.length > 0 && ctx.hasUI)
      ctx.ui.notify(
        `pi-agents ignores these profiles:\n${fresh.join("\n")}`,
        "warning",
      );
    const appendix = buildSystemPromptAppendix(profiles, ctx.scopedModels);
    return { systemPrompt: `${event.systemPrompt}\n\n${appendix}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    track(ctx);
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
