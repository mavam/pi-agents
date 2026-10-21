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
import { AgentStatePublisher } from "./pi/events.js";
import { registerMessageRenderers } from "./pi/messages.js";
import { leaveNotice, notify, pausedNotice, takeNotice } from "./pi/notify.js";
import { PiParent } from "./pi/parent.js";
import { buildSystemPromptAppendix, profileCatalog } from "./pi/prompt.js";
import { SessionHost } from "./pi/session.js";
import { isTrusted } from "./pi/spawn.js";
import { registerAgentTools } from "./pi/tools.js";
import {
  MessageTranscript,
  registerMessageEntryRenderer,
} from "./pi/transcript.js";
import { FocusController } from "./ui/focus.js";
import { FancyFooterReporter } from "./ui/footer.js";
import { statusOf } from "./ui/format.js";
import { AgentPanel } from "./ui/panel.js";

export default function agentExtension(pi: ExtensionAPI): void {
  const parent = new PiParent(pi);
  const host = new SessionHost(parent, { events: pi.events });
  const state = new AgentStatePublisher(
    pi.events,
    () => host.current()?.list() ?? [],
  );
  const panel = new AgentPanel(host);
  const focus = new FocusController(host, panel);
  const transcript = new MessageTranscript(pi);
  // The footer counts Pi's agents: open ones, and closed ones that
  // messaging opens again. Agents that agents spawned belong to their
  // agent, so closed ones drop out.
  const footer = new FancyFooterReporter(pi, () => {
    const service = host.current();
    if (!service) return [];
    const helperGraphs = new Set(
      service
        .graphs({ includeClosed: true })
        .filter((graph) => graph.owner)
        .map((graph) => graph.id),
    );
    return service
      .list({ includeClosed: true })
      .filter(
        (agent) =>
          statusOf(agent) !== "closed" ||
          !agent.graph ||
          !helperGraphs.has(agent.graph),
      );
  });

  // A click on a panel row attaches, like ⏎.
  panel.onAttach = (agentId) => focus.attachTo(agentId);
  // While the user is attached to an agent, nothing wakes the parent.
  parent.setBlocked(() => focus.isPaneOpen());
  focus.onPaneClosed = (ctx) => {
    parent.setContext(ctx);
    parent.notify();
  };
  host.subscribe(() => {
    state.update();
    panel.update();
    footer.update();
    // Messages sent before messaging was turned off still get their cards,
    // also those a crash left behind and the service delivers at start.
    transcript.sync(host.current()?.messages() ?? []);
  });

  registerMessageRenderers(pi);
  registerMessageEntryRenderer(pi);
  // A steer ends waits for agents, so Pi doesn't hold it back.
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") parent.steer();
    return { action: "continue" };
  });
  registerAgentTools(pi, host);
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
    const appendix = buildSystemPromptAppendix(
      profiles,
      ctx.scopedModels,
      ctx.mode === "print" || ctx.mode === "json",
    );
    return { systemPrompt: `${event.systemPrompt}\n\n${appendix}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    track(ctx);
    // Agents the previous session paused: tell the user, and Pi, so it
    // doesn't assume they still work.
    const sessionFile = ctx.sessionManager.getSessionFile();
    const paused = sessionFile ? takeNotice(sessionFile) : undefined;
    if (paused) {
      notify(ctx, paused, "warning");
      pi.sendMessage({
        customType: "pi-agents-paused",
        content: paused,
        display: true,
      });
    }
    focus.install(ctx);
    panel.update(ctx);
    transcript.start(ctx);
    await host.start(ctx);
    state.start(ctx.sessionManager.getSessionId());
    panel.update(ctx);
    footer.update();
    parent.notify();
  });

  pi.on("agent_start", (_event, ctx) => track(ctx));

  pi.on("session_shutdown", async (event, ctx) => {
    // Switching away pauses this session's agents; the next session tells
    // about them. Quitting pauses them too, but then nobody is left to tell.
    const service = host.current();
    // Agents of a session without a file end with it; there's nothing to
    // resume.
    if (
      service &&
      ctx.sessionManager.getSessionFile() &&
      event.targetSessionFile &&
      event.reason !== "reload"
    ) {
      const notice = pausedNotice(service.list(), service.graphs());
      if (notice) {
        try {
          leaveNotice(event.targetSessionFile, notice);
        } catch {
          notify(ctx, notice, "warning");
        }
      }
    }
    state.dispose();
    focus.dispose();
    panel.dispose();
    parent.clear();
    footer.dispose();
    transcript.stop();
    await host.stop();
  });
}
