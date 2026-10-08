/**
 * Slash commands: `/agents` opens the agent overlay, `/agent <name>`
 * attaches to an agent.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isGroupVisible, isVisible } from "../agents/service.js";
import type { AgentInfo, GroupInfo, MemberOutcome } from "../agents/types.js";
import {
  confirmAndStop,
  errorText,
  type FocusController,
  stopTarget,
} from "../ui/focus.js";
import {
  type Colorize,
  formatElapsed,
  formatUsage,
  groupNote,
  oneLine,
  STATE_STYLES,
  shortModel,
  stateIcon,
} from "../ui/format.js";
import { type OverlaySpec, openOverlay } from "../ui/overlay.js";
import type { AgentPanel } from "../ui/panel.js";
import { attachTarget, buildRows, type Row } from "../ui/rows.js";
import type { SessionHost } from "./session.js";

/** Lines of the latest result shown in the overlay's detail pane. */
const DETAIL_RESULT_LINES = 200;
/** Lines of each agent's result in a group's detail pane. */
const DETAIL_MEMBER_LINES = 4;

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

function agentRow(
  agent: AgentInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
  indent = "",
): string {
  const usage = formatUsage(agent.usage);
  const name = pad(agent.name, nameWidth - indent.length);
  return [
    `${indent}${stateIcon(agent.state, color)} ${isVisible(agent) ? name : color("dim", name)}`,
    color("dim", pad(agent.profile ?? "ad-hoc", 10)),
    color("dim", pad(shortModel(agent), 14)),
    color("dim", pad(formatElapsed(now - agent.stateSince), 7)),
    usage ? color("dim", usage) : "",
  ].join("  ");
}

function groupRow(
  group: GroupInfo,
  now: number,
  nameWidth: number,
  color: Colorize,
): string {
  const usage = formatUsage(group.usage);
  const name = pad(group.name, nameWidth);
  return [
    `${stateIcon(group.state, color)} ${isGroupVisible(group) ? name : color("dim", name)}`,
    color("dim", pad("group", 10)),
    color("dim", pad(`${group.members.length} agents`, 14)),
    color("dim", pad(formatElapsed(now - group.stateSince), 7)),
    usage ? color("dim", usage) : "",
  ].join("  ");
}

function memberSummary(
  outcome: MemberOutcome | undefined,
  agent: AgentInfo | undefined,
): string {
  if (!outcome) return agent?.state ?? "working";
  if (outcome.kind === "answered")
    return outcome.result.stopReason === "error" ? "failed" : "answered";
  if (outcome.kind === "failed") return `failed: ${outcome.reason}`;
  return outcome.kind;
}

function groupDetail(
  group: GroupInfo,
  lookup: (id: string) => AgentInfo | undefined,
  color: Colorize,
): string[] {
  const lines = [color("accent", "Agents")];
  for (const member of group.members) {
    const agent = lookup(member.agentId);
    const outcome = member.outcome;
    lines.push(
      `${agent ? stateIcon(agent.state, color) : " "} ${member.name} ${color("dim", memberSummary(outcome, agent))}`,
    );
    if (agent) lines.push(color("dim", `  ${oneLine(agent.task, 200)}`));
    if (outcome?.kind === "answered" && outcome.result.text) {
      const body = outcome.result.text.split("\n");
      lines.push(
        ...body.slice(0, DETAIL_MEMBER_LINES).map((line) => `  ${line}`),
      );
      if (body.length > DETAIL_MEMBER_LINES)
        lines.push(
          color(
            "dim",
            `  … ${body.length - DETAIL_MEMBER_LINES} more lines (attach to read)`,
          ),
        );
    }
  }
  return lines;
}

function rowName(row: Row): string {
  return row.kind === "group"
    ? row.group.name
    : `${row.nested ? "  " : ""}${row.agent.name}`;
}

function agentDetail(agent: AgentInfo, color: Colorize): string[] {
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
  let after: (() => void) | undefined;
  // Groups and agents, open ones first, then closed ones, newest first; a
  // group's agents follow it.
  const items = () =>
    buildRows(
      {
        agents: service.list({ includeClosed: true }),
        groups: service.groups({ includeClosed: true }),
        agent: (id) => service.get(id),
      },
      (left, right) =>
        Number(!right.closed || right.state === "working") -
          Number(!left.closed || left.state === "working") ||
        right.createdAt - left.createdAt,
      () => true,
    );
  const spec: OverlaySpec<Row> = {
    title: "Agents",
    emptyText: "No agents yet. Ask Pi to delegate.",
    footer: "↑↓ move · ⏎ attach · s stop · esc",
    items,
    keyOf: (row) => row.key,
    row: (row, color) => {
      const width = Math.max(...items().map((item) => rowName(item).length), 4);
      return row.kind === "group"
        ? groupRow(row.group, Date.now(), width, color)
        : agentRow(row.agent, Date.now(), width, color, row.nested ? "  " : "");
    },
    headerLine: (row, color) => {
      if (row.kind === "agent") {
        const agent = row.agent;
        return color(
          "dim",
          `${agent.name} · ${agent.cwd} · started ${formatElapsed(Date.now() - agent.createdAt)} ago`,
        );
      }
      const group = row.group;
      const note = groupNote(group);
      return color(
        "dim",
        [
          `${group.name} · group of ${group.members.length}`,
          group.policy === "failFast" ? "stops on failure" : "waits for all",
          ...(note ? [note] : []),
          `started ${formatElapsed(Date.now() - group.createdAt)} ago`,
        ].join(" · "),
      );
    },
    detail: (row, color) =>
      row.kind === "agent"
        ? agentDetail(row.agent, color)
        : groupDetail(row.group, (id) => service.get(id), color),
    onAction: (key, row) => {
      if (key === "enter") {
        const agentId = attachTarget(row);
        if (!agentId) return undefined;
        after = () => deps.focus.attach(ctx, agentId);
        return "close";
      }
      if (key === "s") {
        const target = stopTarget(row);
        const visible =
          row.kind === "agent"
            ? isVisible(row.agent)
            : isGroupVisible(row.group);
        if (!visible) return undefined;
        if (target.state !== "working") {
          void service
            .stop(target.id)
            .catch((error) => ctx.ui.notify(errorText(error), "error"));
          return undefined;
        }
        after = () => void confirmAndStop(ctx, deps.host, target);
        return "close";
      }
      return undefined;
    },
    live: () =>
      items().some(
        (row) =>
          (row.kind === "agent" ? row.agent.state : row.group.state) ===
          "working",
      ),
  };
  await openOverlay(ctx, spec, deps.panel);
  after?.();
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("agents", {
    description: "Browse agents: attach to or stop them",
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
      const service = deps.host.current();
      const names = new Set(
        (service?.list({ includeClosed: true }) ?? []).map(
          (agent) => agent.name,
        ),
      );
      const matches = [...names]
        .filter((name) => name.startsWith(prefix))
        .flatMap((name) => service?.get(name) ?? []);
      return matches.length === 0
        ? null
        : matches.map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: `${STATE_STYLES[agent.state].icon} ${agent.task.replace(/\s+/g, " ").slice(0, 60)}`,
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
      if (!agent) {
        ctx.ui.notify(`No agent named ${name}.`, "warning");
        return;
      }
      deps.focus.attach(ctx, agent.id);
    },
  });
}
