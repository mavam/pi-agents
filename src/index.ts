/**
 * pi-agents: durable, named agents for Pi, running in-process on pi-durable.
 * This entry point wires the session host, the parent (Pi's session), the
 * parent tools, and the TUI surfaces.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./pi/commands.js";
import { registerMessageRenderers } from "./pi/messages.js";
import { PiParent } from "./pi/parent.js";
import { buildSystemPromptAppendix, profileCatalog } from "./pi/prompt.js";
import { SessionHost } from "./pi/session.js";
import { isTrusted } from "./pi/spawn.js";
import { registerAgentTools } from "./pi/tools.js";
import { FocusController } from "./ui/focus.js";
import { FancyFooterReporter } from "./ui/footer.js";
import { AgentPanel } from "./ui/panel.js";

export default function agentExtension(pi: ExtensionAPI): void {
  const parent = new PiParent(pi);
  const host = new SessionHost(parent);
  const panel = new AgentPanel(host);
  const focus = new FocusController(host, panel);
  const footer = new FancyFooterReporter(
    pi,
    () => host.current()?.list() ?? [],
  );

  // While the user is attached to an agent, nothing wakes the parent.
  parent.setBlocked(() => focus.isPaneOpen());
  focus.onPaneClosed = (ctx) => {
    parent.setContext(ctx);
    parent.notify();
  };
  host.subscribe(() => {
    panel.update();
    footer.update();
  });

  registerMessageRenderers(pi);
  // A steer ends waits for agents, so Pi doesn't hold it back.
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") parent.steer();
    return { action: "continue" };
  });
  registerAgentTools(pi, host, parent);
  parent.listen();
  registerCommands(pi, { host, panel, focus });
  pi.registerShortcut("ctrl+q", {
    description: "Focus the pi-agents panel",
    handler: (ctx) => focus.focusPanel(ctx),
  });

  const track = (ctx: ExtensionContext): void => {
    host.setContext(ctx);
    parent.setContext(ctx);
  };

  // Profile problems are reported once per session, not on every turn.
  const reported = new Set<string>();
  pi.on("before_agent_start", async (event, ctx) => {
    track(ctx);
    const { profiles, issues } = await profileCatalog(
      ctx.cwd,
      isTrusted(ctx),
      ctx.modelRegistry.getAvailable(),
      host.skills.get,
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
    parent.notify();
  });

  pi.on("agent_start", (_event, ctx) => track(ctx));

  pi.on("session_shutdown", async () => {
    focus.dispose();
    panel.dispose();
    parent.clear();
    footer.dispose();
    await host.stop();
  });
}
