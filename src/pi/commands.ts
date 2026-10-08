/**
 * Slash commands: `/agents` opens the agent overlay, `/agent <name>`
 * attaches to an agent.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "../agents/types.js";
import {
  confirmAndClose,
  errorText,
  type FocusController,
} from "../ui/focus.js";
import {
  type Colorize,
  formatElapsed,
  formatUsage,
  shortModel,
  stateIcon,
} from "../ui/format.js";
import { type OverlaySpec, openOverlay } from "../ui/overlay.js";
import type { AgentPanel } from "../ui/panel.js";
import type { SessionHost } from "./session.js";

/** Lines of the latest result shown in the overlay's detail pane. */
const DETAIL_RESULT_LINES = 200;

export interface CommandDeps {
  host: SessionHost;
  panel: AgentPanel;
  focus: FocusController;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

export function agentRow(
  agent: AgentInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
): string {
  const usage = formatUsage(agent.usage);
  return [
    `${stateIcon(agent.state, color)} ${pad(agent.name, nameWidth)}`,
    pad(agent.closed ? "closed" : agent.state, 8),
    color("dim", pad(agent.profile ?? "ad-hoc", 10)),
    color("dim", pad(shortModel(agent), 14)),
    color("dim", pad(formatElapsed(now - agent.stateSince), 7)),
    usage ? color("dim", usage) : "",
  ].join("  ");
}

export function agentDetail(agent: AgentInfo, color: Colorize): string[] {
  const lines = [color("accent", "Task"), ...agent.task.split("\n")];
  const result = agent.result;
  if (agent.state === "failed") {
    lines.push(
      "",
      color(
        "error",
        `Error: ${result?.errorMessage ?? "the last answer failed"}`,
      ),
    );
  } else if (result?.text) {
    const body = result.text.split("\n");
    lines.push(
      "",
      color("accent", "Latest result"),
      ...body.slice(0, DETAIL_RESULT_LINES),
    );
    if (body.length > DETAIL_RESULT_LINES)
      lines.push(
        color(
          "dim",
          `… ${body.length - DETAIL_RESULT_LINES} more lines (attach to read)`,
        ),
      );
  }
  return lines;
}

async function openAgentsOverlay(
  ctx: ExtensionContext,
  deps: CommandDeps,
): Promise<void> {
  const service = await deps.host.ensure(ctx);
  let showClosed = false;
  let after: (() => void) | undefined;
  const items = () =>
    service
      .list({ includeClosed: showClosed })
      .sort(
        (left, right) =>
          Number(left.closed) - Number(right.closed) ||
          right.createdAt - left.createdAt,
      );
  const spec: OverlaySpec<AgentInfo> = {
    title: () => (showClosed ? "Agents (with closed)" : "Agents"),
    emptyText: () =>
      showClosed
        ? "No agents yet."
        : "No open agents. Ask Pi to delegate, or press a to show closed agents.",
    footer: "↑↓ move · ⏎ attach · s stop · x close · a closed · esc",
    items,
    keyOf: (agent) => agent.id,
    row: (agent, color) => {
      const width = Math.max(...items().map((item) => item.name.length), 4);
      return agentRow(agent, Date.now(), width, color);
    },
    headerLine: (agent, color) =>
      color(
        "dim",
        `${agent.name} · ${agent.cwd} · started ${formatElapsed(Date.now() - agent.createdAt)} ago`,
      ),
    detail: (agent, color) => agentDetail(agent, color),
    onAction: (key, agent) => {
      if (key === "enter") {
        if (agent.closed) return undefined;
        after = () => deps.focus.attach(ctx, agent.id);
        return "close";
      }
      if (key === "s") {
        if (agent.state === "working")
          void service
            .stop(agent.id)
            .catch((error) => ctx.ui.notify(errorText(error), "error"));
        return undefined;
      }
      if (key === "x") {
        if (agent.closed) return undefined;
        after = () => void confirmAndClose(ctx, deps.host, agent);
        return "close";
      }
      if (key === "a") {
        showClosed = !showClosed;
        return undefined;
      }
      return undefined;
    },
    live: () => items().some((agent) => agent.state === "working"),
  };
  await openOverlay(ctx, spec, deps.panel);
  after?.();
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("agents", {
    description: "Browse agents: attach, stop, or close them",
    handler: async (_args, ctx) => {
      try {
        await openAgentsOverlay(ctx, deps);
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("agent", {
    description: "Attach to an agent",
    getArgumentCompletions: (prefix) => {
      const agents = deps.host.current()?.list() ?? [];
      const matches = agents.filter((agent) => agent.name.startsWith(prefix));
      return matches.length === 0
        ? null
        : matches.map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: `${agent.state} · ${agent.task.replace(/\s+/g, " ").slice(0, 60)}`,
          }));
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        await openAgentsOverlay(ctx, deps).catch((error) =>
          ctx.ui.notify(errorText(error), "error"),
        );
        return;
      }
      const agent = deps.host.current()?.get(name);
      if (!agent || agent.closed) {
        ctx.ui.notify(`No open agent named ${name}.`, "warning");
        return;
      }
      deps.focus.attach(ctx, agent.id);
    },
  });
}
