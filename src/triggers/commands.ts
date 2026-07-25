/**
 * Slash commands: the static catalog commands (/agents, /agent, /workflows,
 * /workflow) plus dynamic per-workflow commands (each saved workflow
 * registers /<name>, running its graph directly with args bound to params —
 * no model round-trip). Runs have no top-level command of their own: browse
 * them via /workflows, inspect one via /workflow <run-id>.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Agent, discoverAgents } from "../catalog/agents.js";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import type { Scope, WorkflowDef, WorkflowParamDef } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { isProjectTrusted } from "../run/persist.js";
import {
  type NodeView,
  type RunView,
  type SteeringEntry,
  workNodes,
} from "../run/state.js";
import { toMermaid } from "../ui/mermaid.js";
import {
  type OverlayAction,
  type OverlaySpec,
  openOverlay,
} from "../ui/overlay.js";
import {
  fenced,
  formatRunOverviewLine,
  formatRunSource,
  formatUsage,
  formatValuePreview,
  nodeDisplayName,
  renderResultValue,
  sendInfo,
  shortId,
} from "../ui/render.js";
import { STATUS_STYLES } from "../ui/status.js";
import { KIND_ICONS, renderFlowTree, renderRunTree } from "../ui/tree.js";
import { type Colorize, formatElapsed } from "../ui/widget.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

/** Command names that saved workflows may not claim. */
export const RESERVED_COMMAND_NAMES = new Set([
  "agents",
  "agent",
  "workflows",
  "workflow",
  "runs",
  "run",
]);

export type CommandDeps = TriggerDeps;

/** Run-inspection verbs accepted by `/workflow <run-id> …`. */
const RUN_ACTIONS = ["result", "agents", "watch", "mermaid", "stop"];

/** Discovery scope for a context: untrusted projects contribute nothing. */
function scopeFor(ctx: Pick<ExtensionContext, "isProjectTrusted">): Scope {
  return isProjectTrusted(ctx as ExtensionContext) ? "both" : "user";
}

// ---------------------------------------------------------------------------
// Static commands

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("agents", {
    description:
      "Browse discovered agents (interactive in the TUI; `list` for text)",
    getArgumentCompletions: (prefix) =>
      ["list"]
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => ({ value: arg, label: arg })),
    handler: async (args, ctx) => {
      if (ctx.hasUI && ctx.mode === "tui" && args.trim() !== "list") {
        await openOverlay(ctx, buildAgentsSpec(pi, ctx));
        return;
      }
      const discovery = discoverAgents(ctx.cwd, scopeFor(ctx));
      const lines = ["## Agents", ""];
      if (discovery.agents.length === 0) {
        lines.push(
          "No agent profiles found. Workflows can still delegate with anonymous ad-hoc agents (omit the agent name). To define a reusable persona, create `.pi/agents/<name>.md` or `~/.pi/agent/agents/<name>.md`.",
        );
      }
      for (const agent of discovery.agents) {
        lines.push(
          `- **${agent.name}** (${agent.source}): ${agent.description}`,
        );
      }
      for (const diagnostic of discovery.diagnostics) {
        lines.push(`- ⚠ ${diagnostic.filePath}: ${diagnostic.message}`);
      }
      sendInfo(pi, lines.join("\n"));
    },
  });

  pi.registerCommand("agent", {
    description: "Show details for one agent",
    getArgumentCompletions: (prefix) => {
      const discovery = discoverAgents(process.cwd(), "both");
      return discovery.agents
        .filter((agent) => agent.name.startsWith(prefix))
        .map((agent) => ({
          value: agent.name,
          label: agent.name,
          description: agent.description,
        }));
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        sendInfo(pi, "Usage: `/agent <name>`");
        return;
      }
      const discovery = discoverAgents(ctx.cwd, scopeFor(ctx));
      const agent = discovery.agents.find((a) => a.name === name);
      if (!agent) {
        sendInfo(pi, `Unknown agent \`${name}\`. Try \`/agents\`.`);
        return;
      }
      sendInfo(pi, formatAgentDetails(agent));
    },
  });

  pi.registerCommand("workflows", {
    description:
      "Browse workflows and their runs (interactive in the TUI; `list`/`runs` for text, `widget` to toggle the live summary)",
    getArgumentCompletions: (prefix) =>
      ["list", "runs", "widget"]
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => ({ value: arg, label: arg })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "widget") {
        const enabled = deps.widget.toggleEnabled();
        ctx.ui.notify(
          `Live run summary ${enabled ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }
      if (arg === "runs") {
        const runs = [...deps.manager.state.runs.values()];
        if (runs.length === 0) {
          sendInfo(pi, "No runs yet.");
          return;
        }
        const lines = ["## Runs", "", "```"];
        for (const run of runs.slice(-30)) {
          lines.push(formatRunOverviewLine(run));
        }
        lines.push("```", "", "Inspect one with `/workflow <id>`.");
        sendInfo(pi, lines.join("\n"));
        return;
      }
      if (ctx.hasUI && ctx.mode === "tui" && arg !== "list") {
        await openOverlay(ctx, buildWorkflowsSpec(pi, deps, ctx));
        return;
      }
      const { workflows, diagnostics } = discoverWorkflows(
        ctx.cwd,
        scopeFor(ctx),
      );
      const lines = ["## Workflows", ""];
      if (workflows.length === 0) {
        lines.push(
          "No workflows found. Create `.pi/workflows/<name>.yaml` or `~/.pi/agent/workflows/<name>.yaml`.",
        );
      }
      for (const wf of workflows) {
        const triggers =
          wf.on && wf.on.length > 0 ? ` — on: ${wf.on.join(", ")}` : "";
        lines.push(
          `- **/${wf.name}** (${wf.source}): ${wf.description}${triggers}`,
        );
      }
      for (const diagnostic of diagnostics) {
        lines.push(`- ⚠ ${diagnostic.filePath}: ${diagnostic.message}`);
      }
      sendInfo(pi, lines.join("\n"));
    },
  });

  pi.registerCommand("workflow", {
    description:
      "Show a workflow, or inspect a run: /workflow <name>, /workflow <run-id> [result [node]|agents|watch|mermaid|stop]",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.split(/\s+/);
      const { workflows } = discoverWorkflows(process.cwd(), "both");
      // Run verbs never follow a workflow name; they only follow a run id.
      if (tokens.length > 1 && workflows.some((wf) => wf.name === tokens[0]))
        return [];
      const completions = completeRunArgs(prefix, [
        ...deps.manager.state.runs.values(),
      ]);
      if (tokens.length <= 1) {
        completions.unshift(
          ...workflows
            .filter((wf) => wf.name.startsWith(prefix))
            .map((wf) => ({
              value: wf.name,
              label: wf.name,
              description: wf.description,
            })),
        );
      }
      return completions;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.find((t) => RUN_ACTIONS.includes(t));
      const [target, nodeRef] = tokens.filter((t) => !RUN_ACTIONS.includes(t));
      if (!target) {
        sendInfo(
          pi,
          "Usage: `/workflow <name>` or `/workflow <run-id> [result [node]|agents|watch|mermaid|stop]`",
        );
        return;
      }
      // A saved workflow name wins over a run-id prefix; names are slugs
      // and run ids are hex, so collisions are implausible.
      const { workflows } = discoverWorkflows(ctx.cwd, scopeFor(ctx));
      const wf = resolveWorkflowByName(workflows, target);
      if (wf) {
        if (action) {
          sendInfo(
            pi,
            `\`${action}\` applies to runs, not workflow definitions. Browse runs with \`/workflows\`.`,
          );
          return;
        }
        sendInfo(pi, formatWorkflowDetails(wf));
        return;
      }
      const lookup = deps.manager.find(target);
      if (lookup.kind === "missing") {
        sendInfo(
          pi,
          `No workflow or run matching \`${target}\`. Try \`/workflows\`.`,
        );
        return;
      }
      if (lookup.kind === "ambiguous") {
        sendInfo(
          pi,
          `Ambiguous run id \`${target}\`: ${lookup.matches.map((run) => shortId(run.header.id)).join(", ")}`,
        );
        return;
      }
      const run = lookup.run;
      if (action === "stop") {
        const stopped = deps.manager.stop(run.header.id);
        sendInfo(
          pi,
          stopped
            ? `Stopping run ${shortId(run.header.id)}…`
            : "Run is not live.",
        );
        return;
      }
      if (action === "agents") {
        sendInfo(pi, formatRunNodesList(run));
        return;
      }
      if (action === "result") {
        if (nodeRef) {
          const found = findNodeInRun(run, nodeRef);
          if (found.kind === "missing") {
            const names = workNodes(run).map(
              (node) => `\`${nodeDisplayName(node)}\``,
            );
            sendInfo(
              pi,
              `No agent matching \`${nodeRef}\` in run ${shortId(run.header.id)}.${names.length > 0 ? ` Available: ${names.join(", ")}.` : ""}`,
            );
            return;
          }
          if (found.kind === "ambiguous") {
            sendInfo(
              pi,
              `Ambiguous agent \`${nodeRef}\`: ${found.matches.map((node) => `\`${nodeDisplayName(node)}\``).join(", ")}.`,
            );
            return;
          }
          sendInfo(pi, formatNodeResultFull(run, found.node));
          return;
        }
        sendInfo(pi, formatRunResultFull(run));
        return;
      }
      if (action === "watch") {
        sendInfo(pi, formatRunDetails(run));
        if (deps.manager.isLive(run.header.id)) {
          watchUntilDone(pi, deps, run.header.id);
          sendInfo(
            pi,
            "Watching — the final tree will be posted when the run settles.",
          );
        }
        return;
      }
      if (action === "mermaid") {
        sendInfo(pi, `\`\`\`mermaid\n${toMermaid(run.header.flow)}\n\`\`\``);
        return;
      }
      sendInfo(pi, formatRunDetails(run));
    },
  });
}

// ---------------------------------------------------------------------------
// Interactive overlays (TUI only; non-TUI modes keep the markdown output)

/** Overlay rows for the unified /workflows overlay: workflows and run groups
 * (tier 1), one group's runs (tier 2), one run's work nodes (tier 3). */
export type WorkflowsItem =
  | { kind: "all" }
  | { kind: "workflow"; wf: WorkflowDef }
  | { kind: "adhoc" }
  | { kind: "run"; run: RunView }
  | { kind: "node"; run: RunView; node: NodeView };

/** Compact provenance marker for steering history in the overlay. */
export function steeringMarker(
  entry: Pick<SteeringEntry, "source" | "caller">,
): string {
  if (entry.source === "user") return "↪";
  if (entry.source === "tool") return "✦";
  return entry.caller ? `⇢ ${entry.caller}:` : "⇢";
}

// Run- and node-tier rendering and actions, shared between the unified
// overlay's drill levels.

function nodeRow(node: NodeView, color: Colorize): string {
  const presentation = STATUS_STYLES[node.status];
  const icon = color(presentation.color, presentation.icon);
  const usage = formatUsage(
    node.usage ?? (node.status === "running" ? node.progressUsage : undefined),
  );
  return `${icon} ${nodeDisplayName(node).padEnd(12)}  ${(node.agent ?? "ad-hoc").padEnd(10)}  ${node.status.padEnd(9)}${usage ? `  ${color("dim", usage)}` : ""}`;
}

function runRow(run: RunView, color: Colorize, deps: CommandDeps): string {
  const presentation = STATUS_STYLES[run.status];
  const icon = color(presentation.color, presentation.icon);
  const label =
    run.header.label ?? run.header.source.workflow ?? run.header.flow.kind;
  const source = formatRunSource(run.header.source);
  const usage = formatUsage(run.usage);
  const hidden = deps.widget.isHidden(run.header.id)
    ? color("dim", "  ⊘ hidden")
    : "";
  return `${icon} ${color("dim", shortId(run.header.id))}  ${run.status.padEnd(9)}  ${`${label} (${source})`.padEnd(24)}${usage ? `  ${color("dim", usage)}` : ""}${hidden}`;
}

function nodeHeaderLine(run: RunView, node: NodeView, color: Colorize): string {
  const parts = [
    shortId(run.header.id),
    nodeDisplayName(node),
    node.agent ?? "ad-hoc",
    formatElapsed((node.endedAt ?? Date.now()) - node.startedAt),
    formatUsage(node.usage) || undefined,
    node.status === "running" ? node.progressTool : undefined,
    node.status === "running" && node.lastProgressAt !== undefined
      ? `active ${formatElapsed(Date.now() - node.lastProgressAt)} ago`
      : undefined,
  ];
  return parts
    .filter((part): part is string => part !== undefined)
    .join(color("dim", " · "));
}

function runHeaderLine(run: RunView, color: Colorize): string {
  const parts = [
    shortId(run.header.id),
    run.header.label ?? run.header.flow.kind,
    formatElapsed((run.endedAt ?? Date.now()) - run.createdAt),
    formatUsage(run.usage) || undefined,
  ];
  return parts
    .filter((part): part is string => part !== undefined)
    .join(color("dim", " · "));
}

function nodeDetail(node: NodeView, color: Colorize): string[] {
  const steering = (node.steering ?? []).flatMap((entry) =>
    entry.message
      .split("\n")
      .map((line, index) =>
        color(
          "accent",
          index === 0 ? `${steeringMarker(entry)} ${line}` : `  ${line}`,
        ),
      ),
  );
  if (node.error)
    return [
      ...steering,
      ...(steering.length > 0 ? [""] : []),
      color("error", `✗ ${node.error}`),
    ];
  if (node.status === "cancelled")
    return [
      ...steering,
      ...(steering.length > 0 ? [""] : []),
      color(
        "dim",
        `cancelled${node.cancelReason ? ` (${node.cancelReason})` : ""}`,
      ),
    ];
  if (node.status === "running") {
    const tail = (node.progressText ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-3);
    return tail.length > 0
      ? [...steering, ...tail.map((line) => color("dim", line))]
      : [...steering, color("dim", "running…")];
  }
  const preview = formatValuePreview(node.value, 600);
  const lines = preview
    ? preview.split("\n")
    : [color("dim", "(no output value)")];
  lines.push("", color("dim", "⏎ post full output"));
  return [...steering, ...(steering.length > 0 ? [""] : []), ...lines];
}

function runDetail(run: RunView, color: Colorize): string[] {
  const lines = (renderRunTree(run, color) || "(no nodes yet)").split("\n");
  if (run.error) lines.push(color("error", `✗ ${run.error}`));
  const value =
    run.status !== "running" ? formatValuePreview(run.value, 300) : "";
  if (value) lines.push("", ...value.split("\n"));
  return lines;
}

/** Node-tier actions: post the full output, steer a live agent. */
function nodeAction(
  key: string,
  run: RunView,
  node: NodeView,
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): OverlayAction {
  if (key === "enter") {
    sendInfo(pi, formatNodeResultFull(run, node));
    return "close";
  }
  if (
    key === "s" &&
    deps.manager.steerableInstances(run.header.id).includes(node.instance)
  ) {
    return {
      compose: {
        label: "Steer",
        submit: async (message) => {
          const result = await deps.manager.steer(
            run.header.id,
            node.instance,
            message,
            "user",
          );
          ctx.ui.notify(
            result.status === "queued"
              ? "Steering queued — delivery follows the current tool-call batch."
              : result.status === "rejected"
                ? result.error
                : "Agent is no longer steerable.",
            result.status === "queued" ? "info" : "warning",
          );
        },
      },
    };
  }
  return undefined;
}

/** Run-tier actions: post details, cancel, hide from the widget, rerun. */
function runAction(
  key: string,
  run: RunView,
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): OverlayAction {
  if (key === "enter") {
    sendInfo(pi, formatRunDetails(run, true));
    return "close";
  }
  if (key === "c") {
    const stopped = deps.manager.stop(run.header.id);
    ctx.ui.notify(
      stopped ? `Stopping run ${shortId(run.header.id)}…` : "Run is not live.",
      stopped ? "info" : "warning",
    );
  }
  if (key === "h") {
    const hidden = deps.widget.toggleHidden(run.header.id);
    ctx.ui.notify(
      `Run ${shortId(run.header.id)} ${hidden ? "hidden from" : "shown in"} the live summary.`,
      "info",
    );
  }
  if (key === "r") {
    deps.notifications.setContext(ctx);
    try {
      const started = startTriggeredRun(deps, {
        flow: run.header.flow,
        cwd: run.header.cwd ?? ctx.cwd,
        scope: run.header.scope,
        label: run.header.label,
        budgets: run.header.budgets,
        source: run.header.source,
        ctx,
        background: true,
      });
      ctx.ui.notify(`Started run ${shortId(started.runId)}.`, "info");
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
  return undefined;
}

export function buildWorkflowsSpec(
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): OverlaySpec<WorkflowsItem> {
  // Drill-down is a mode switch, not a nested overlay: ctx.ui.custom shows a
  // single focused component, so items()/chrome/actions branch on this state.
  // Two levels: a workflow (or run group) drills into its runs, and a run
  // drills into its work nodes. drillGroup.key remembers the tier-1 row to
  // reselect when backing out.
  let drillGroup: { group: string; key: string } | undefined;
  let drillRunId: string | undefined;
  // Discover once per overlay open: with live() active the overlay re-renders
  // every 500ms and must not hit the filesystem each render.
  const workflows = discoverWorkflows(ctx.cwd, scopeFor(ctx)).workflows;

  const allRuns = () => [...deps.manager.state.runs.values()];
  const groupRuns = (group: string): RunView[] =>
    allRuns().filter((run) =>
      group === "all"
        ? true
        : group === "adhoc"
          ? run.header.source.workflow === undefined
          : run.header.source.workflow === group,
    );
  const drilledRun = (): RunView | undefined =>
    drillRunId ? deps.manager.state.runs.get(drillRunId) : undefined;
  const nodeKey = (run: RunView, node: NodeView) =>
    `node:${run.header.id}:${node.instance}`;
  const groupOf = (item: WorkflowsItem): string =>
    item.kind === "workflow" ? item.wf.name : item.kind;
  const badge = (runs: RunView[], color: Colorize): string => {
    const running = runs.filter((run) => run.status === "running").length;
    const settled = runs.length - running;
    return [
      running > 0 ? color("warning", `◉${running}`) : "",
      settled > 0 ? color("dim", `●${settled}`) : "",
    ]
      .filter(Boolean)
      .join(" ");
  };

  return {
    title: () => {
      const run = drilledRun();
      if (run) return `Run ${shortId(run.header.id)} · agents`;
      if (!drillGroup) return "Workflows";
      if (drillGroup.group === "all") return "Runs";
      if (drillGroup.group === "adhoc") return "Runs · ad-hoc";
      return `Runs · /${drillGroup.group}`;
    },
    emptyText: () =>
      drillRunId
        ? "No agents started yet."
        : drillGroup
          ? "No runs yet."
          : "No workflows found. Create .pi/workflows/<name>.yaml or ~/.pi/agent/workflows/<name>.yaml.",
    footer: () =>
      drillRunId
        ? "↑↓ move · ⏎ post output · esc back"
        : drillGroup
          ? "↑↓ move · ⏎ inspect · a agents · c cancel · r rerun · h hide · esc back"
          : "↑↓ move · ⏎ runs · c compose · r run · n new · esc close",
    footerFor: (item) => {
      if (item.kind === "node") {
        const steerable = deps.manager
          .steerableInstances(item.run.header.id)
          .includes(item.node.instance);
        return `↑↓ move · ⏎ post output${steerable ? " · s steer" : ""} · esc back`;
      }
      if (item.kind === "run")
        return "↑↓ move · ⏎ inspect · a agents · c cancel · r rerun · h hide · esc back";
      if (item.kind === "workflow")
        return "↑↓ move · ⏎ runs · c compose · r run · n new · esc close";
      return "↑↓ move · ⏎ runs · n new · esc close";
    },
    items: () => {
      const run = drilledRun();
      if (run)
        return workNodes(run).map((node) => ({
          kind: "node" as const,
          run,
          node,
        }));
      drillRunId = undefined; // Drilled run evicted: back to the run list.
      if (drillGroup) {
        return groupRuns(drillGroup.group)
          .reverse()
          .map((r) => ({ kind: "run" as const, run: r }));
      }
      const items: WorkflowsItem[] = [];
      if (allRuns().length > 0) items.push({ kind: "all" });
      items.push(...workflows.map((wf) => ({ kind: "workflow" as const, wf })));
      if (groupRuns("adhoc").length > 0) items.push({ kind: "adhoc" });
      return items;
    },
    keyOf: (item) => {
      if (item.kind === "workflow")
        return `wf:${item.wf.source}:${item.wf.name}`;
      if (item.kind === "run") return `run:${item.run.header.id}`;
      if (item.kind === "node") return nodeKey(item.run, item.node);
      return item.kind;
    },
    row: (item, color) => {
      if (item.kind === "node") return nodeRow(item.node, color);
      if (item.kind === "run") return runRow(item.run, color, deps);
      if (item.kind === "workflow") {
        const { wf } = item;
        const triggers =
          wf.on && wf.on.length > 0
            ? color("dim", `  on: ${wf.on.join(", ")}`)
            : "";
        const runs = badge(groupRuns(wf.name), color);
        return `${color("muted", KIND_ICONS.workflow)} ${`/${wf.name}`.padEnd(16)}  ${color("dim", wf.source.padEnd(7))}  ${wf.description}${triggers}${runs ? `  ${runs}` : ""}`;
      }
      const runs = groupRuns(item.kind);
      const running = runs.some((run) => run.status === "running");
      const icon = running ? color("warning", "◉") : color("dim", "●");
      const label = item.kind === "all" ? "all runs" : "(ad-hoc)";
      const description =
        item.kind === "all"
          ? "every run this session"
          : "runs without a saved workflow";
      return `${icon} ${label.padEnd(16)}  ${" ".repeat(7)}  ${color("dim", description)}  ${badge(runs, color)}`;
    },
    headerLine: (item, color) => {
      if (item.kind === "node")
        return nodeHeaderLine(item.run, item.node, color);
      if (item.kind === "run") return runHeaderLine(item.run, color);
      const runs = groupRuns(groupOf(item));
      const count = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
      const parts =
        item.kind === "workflow"
          ? [
              `/${item.wf.name}`,
              item.wf.source,
              ...(runs.length > 0 ? [count] : []),
            ]
          : [item.kind === "all" ? "all runs" : "ad-hoc", count];
      return parts.join(color("dim", " · "));
    },
    detail: (item, color) => {
      if (item.kind === "node") return nodeDetail(item.node, color);
      if (item.kind === "run") return runDetail(item.run, color);
      if (item.kind === "workflow") {
        const { wf } = item;
        const meta = (key: string, value: string) =>
          `${color("dim", `${key}:`)} ${value}`;
        const fallback = (text: string) => color("dim", `(${text})`);
        const lines = [
          color("dim", wf.description),
          "",
          meta("file", wf.filePath),
        ];
        if (wf.trigger) lines.push(meta("trigger", wf.trigger));
        lines.push(
          meta(
            "on",
            wf.on && wf.on.length > 0
              ? wf.on.join(", ") +
                  (wf.debounce !== undefined
                    ? ` (debounce ${wf.debounce}ms)`
                    : "")
              : fallback("manual only"),
          ),
        );
        const runs = groupRuns(wf.name);
        lines.push(
          meta(
            "runs",
            runs.length > 0
              ? `${badge(runs, color)} ${color("dim", "— ⏎ to browse")}`
              : fallback("none yet"),
          ),
        );
        if (wf.params.length === 0) {
          lines.push(meta("params", fallback("none")));
        } else {
          lines.push(meta("params", ""));
          for (const param of wf.params) {
            const flags = [
              param.required ? "required" : undefined,
              param.default !== undefined
                ? `default: ${param.default}`
                : undefined,
            ]
              .filter(Boolean)
              .join(", ");
            lines.push(
              `  ${param.name}${flags ? color("dim", ` (${flags})`) : ""}${param.description ? color("dim", ` — ${param.description}`) : ""}`,
            );
          }
        }
        lines.push("", ...renderFlowTree(wf.flow, color).split("\n"));
        return lines;
      }
      const recent = groupRuns(item.kind).reverse().slice(0, 8);
      return recent.length > 0
        ? recent.map((run) => formatRunOverviewLine(run))
        : [color("dim", "(no runs yet)")];
    },
    onAction: (key, item) => {
      if (item.kind === "node")
        return nodeAction(key, item.run, item.node, pi, deps, ctx);
      if (item.kind === "run") {
        if (key === "a") {
          drillRunId = item.run.header.id;
          const first = workNodes(item.run)[0];
          return first ? { selectKey: nodeKey(item.run, first) } : undefined;
        }
        return runAction(key, item.run, pi, deps, ctx);
      }
      // Tier 1: workflows and run groups.
      if (key === "enter") {
        const group = groupOf(item);
        const newest = groupRuns(group).at(-1);
        drillGroup = {
          group,
          key:
            item.kind === "workflow"
              ? `wf:${item.wf.source}:${item.wf.name}`
              : item.kind,
        };
        return newest ? { selectKey: `run:${newest.header.id}` } : undefined;
      }
      if (key === "n") {
        // Defer past the overlay teardown so the input dialogs get focus.
        setTimeout(() => void newDefinitionWizard(pi, ctx), 0);
        return "close";
      }
      if (item.kind !== "workflow") return undefined;
      if (key === "c") {
        ctx.ui.setEditorText(`/${item.wf.name} `);
        return "close";
      }
      if (key === "r") {
        const missing = item.wf.params.filter(
          (param) => param.required && param.default === undefined,
        );
        if (missing.length > 0) {
          ctx.ui.setEditorText(`/${item.wf.name} `);
          ctx.ui.notify(
            `/${item.wf.name} needs: ${missing.map((param) => param.name).join(", ")}`,
            "warning",
          );
          return "close";
        }
        void runWorkflowCommand(pi, item.wf.name, "", ctx, deps);
        return "close";
      }
      return undefined;
    },
    onCancel: () => {
      if (drillRunId) {
        const id = drillRunId;
        drillRunId = undefined;
        return { selectKey: `run:${id}` };
      }
      if (drillGroup) {
        const key = drillGroup.key;
        drillGroup = undefined;
        return { selectKey: key };
      }
      return "close";
    },
    live: () =>
      [...deps.manager.state.runs.values()].some(
        (run) => run.status === "running",
      ),
  };
}

const AGENT_PROMPT_PREVIEW_LINES = 6;

function buildAgentsSpec(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): OverlaySpec<Agent> {
  return {
    title: "Agents",
    emptyText:
      "No agent profiles found. Workflows can still delegate with anonymous ad-hoc agents (omit the agent name). For a reusable persona, create .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md.",
    footer: "↑↓ move · ⏎ inspect · n new · esc close",
    items: () => discoverAgents(ctx.cwd, scopeFor(ctx)).agents,
    keyOf: (agent) => `${agent.source}:${agent.name}`,
    row: (agent, color) =>
      `${color("muted", KIND_ICONS.agent)} ${agent.name.padEnd(16)}  ${color("dim", agent.source.padEnd(7))}  ${agent.description}`,
    headerLine: (agent, color) => {
      return [agent.name, agent.source].join(color("dim", " · "));
    },
    detail: (agent, color) => {
      const meta = (key: string, value: string) =>
        `${color("dim", `${key}:`)} ${value}`;
      const fallback = (text: string) => color("dim", `(${text})`);
      const lines = [
        color("dim", agent.description),
        "",
        meta("file", agent.filePath),
        meta("model", agent.model ?? fallback("session default")),
        meta("thinking", agent.thinking ?? fallback("session default")),
        meta(
          "skills",
          agent.skills.length > 0 ? agent.skills.join(", ") : fallback("none"),
        ),
        meta(
          "tools",
          agent.tools
            ? agent.tools.join(", ") || fallback("none")
            : fallback("all"),
        ),
      ];
      const prompt = agent.systemPrompt.split("\n");
      if (prompt.some((line) => line.trim())) {
        lines.push("");
        lines.push(...prompt.slice(0, AGENT_PROMPT_PREVIEW_LINES));
        if (prompt.length > AGENT_PROMPT_PREVIEW_LINES) {
          lines.push(
            color(
              "dim",
              `… +${prompt.length - AGENT_PROMPT_PREVIEW_LINES} prompt lines (⏎ for all)`,
            ),
          );
        }
      }
      return lines;
    },
    onAction: (key, agent) => {
      if (key === "enter") {
        sendInfo(pi, formatAgentDetails(agent));
        return "close";
      }
      if (key === "n") {
        // Defer past the overlay teardown so the input dialogs get focus.
        setTimeout(() => void newDefinitionWizard(pi, ctx), 0);
        return "close";
      }
      return undefined;
    },
  };
}

/** Human starts (name + intent), model finishes: draft the definition file. */
async function newDefinitionWizard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const kind = await ctx.ui.select("Create new…", ["workflow", "agent"]);
  if (!kind) return;
  const name = await ctx.ui.input(`New ${kind} name`, "kebab-case-name");
  if (!name?.trim()) return;
  const description = await ctx.ui.input(`What should ${name.trim()} do?`);
  if (!description?.trim()) return;
  const target =
    kind === "workflow"
      ? `.pi/workflows/${name.trim()}.yaml`
      : `.pi/agents/${name.trim()}.md`;
  pi.sendUserMessage(
    [
      `Create a new pi-agents ${kind} named \`${name.trim()}\`: ${description.trim()}`,
      "",
      `Write it to \`${target}\`. Study the existing definitions under \`.pi/\` ` +
        "and the pi-agents README for the format, keep it minimal, and " +
        "verify it appears in `/workflows list` (or `/agents`) afterwards.",
    ].join("\n"),
  );
}

/** Poll a live run and post the final tree once it settles. */
function watchUntilDone(
  pi: ExtensionAPI,
  deps: CommandDeps,
  runId: string,
): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const run = deps.manager.state.runs.get(runId);
    const timedOut = Date.now() - startedAt > 30 * 60 * 1000;
    if (run && run.status === "running" && !timedOut) return;
    clearInterval(timer);
    if (run) sendInfo(pi, formatRunDetails(run));
  }, 500);
  timer.unref?.();
}

function formatAgentDetails(agent: Agent): string {
  const lines = [
    `## ${agent.name} (${agent.source})`,
    "",
    agent.description,
    "",
    `- file: ${agent.filePath}`,
  ];
  if (agent.model) lines.push(`- model: ${agent.model}`);
  if (agent.thinking) lines.push(`- thinking: ${agent.thinking}`);
  if (agent.skills.length > 0)
    lines.push(`- skills: ${agent.skills.join(", ")}`);
  if (agent.tools) lines.push(`- tools: ${agent.tools.join(", ") || "(none)"}`);
  lines.push(
    "",
    "### System prompt",
    "",
    "```",
    agent.systemPrompt || "(empty)",
    "```",
  );
  return lines.join("\n");
}

function formatWorkflowDetails(wf: WorkflowDef): string {
  const lines = [
    `## /${wf.name} (${wf.source})`,
    "",
    wf.description,
    "",
    `- file: ${wf.filePath}`,
  ];
  if (wf.trigger) lines.push(`- trigger: `);
  if (wf.on && wf.on.length > 0) lines.push(`- triggers: ${wf.on.join(", ")}`);
  if (wf.debounce !== undefined) lines.push(`- debounce: ${wf.debounce}ms`);
  if (wf.params.length > 0) {
    lines.push("", "### Params");
    for (const param of wf.params) {
      const flags = [
        param.required ? "required" : undefined,
        param.default !== undefined ? `default: ${param.default}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- \`${param.name}\`${flags ? ` (${flags})` : ""}${param.description ? ` — ${param.description}` : ""}`,
      );
    }
  }
  if (wf.doc) lines.push("", wf.doc);
  lines.push("", "### Flow", "", "```", renderFlowTree(wf.flow), "```");
  lines.push(
    "",
    "### Flow (JSON)",
    "",
    "```json",
    JSON.stringify(wf.flow, null, 2),
    "```",
  );
  return lines.join("\n");
}

const MAX_FULL_RESULT_CHARS = 64_000;

function valueText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? String(value));
}

/** Markdown string or fenced structured value, bounded by MAX_FULL_RESULT_CHARS. */
function fullValueLines(value: unknown, text: string): string[] {
  if (text.length > MAX_FULL_RESULT_CHARS) {
    return [
      `… truncated ${text.length - MAX_FULL_RESULT_CHARS} characters.`,
      "",
      renderResultValue(value, text.slice(0, MAX_FULL_RESULT_CHARS)),
    ];
  }
  return [renderResultValue(value, text)];
}

/** The complete run value (bounded only by what persistence retained). */
function formatRunResultFull(run: RunView): string {
  const lines = [`## Run ${shortId(run.header.id)} — result`, ""];
  if (run.status === "running") {
    lines.push("Still running — no result yet.");
    return lines.join("\n");
  }
  if (run.error) lines.push(`⚠ ${run.error}`, "");
  const text = valueText(run.value);
  if (text === undefined) {
    lines.push("(no result value)");
    return lines.join("\n");
  }
  lines.push(...fullValueLines(run.value, text));
  return lines.join("\n");
}

export type NodeLookup =
  | { kind: "found"; node: NodeView }
  | { kind: "ambiguous"; matches: NodeView[] }
  | { kind: "missing" };

/** Resolve a node reference: exact instance path, display name, or agent name. */
export function findNodeInRun(run: RunView, ref: string): NodeLookup {
  const nodes = workNodes(run);
  const byInstance = nodes.find((node) => node.instance === ref);
  if (byInstance) return { kind: "found", node: byInstance };
  for (const match of [
    nodes.filter((node) => nodeDisplayName(node) === ref),
    nodes.filter((node) => node.agent === ref),
  ]) {
    if (match.length === 1)
      return { kind: "found", node: match[0] as NodeView };
    if (match.length > 1) return { kind: "ambiguous", matches: match };
  }
  return { kind: "missing" };
}

/** One line per work node plus a collapsed output preview. */
export function formatRunNodesList(run: RunView): string {
  const id = shortId(run.header.id);
  const nodes = workNodes(run);
  const lines = [`## Run ${id} — agents`, ""];
  if (nodes.length === 0) {
    lines.push("(no agents started yet)");
    return lines.join("\n");
  }
  const nameWidth = Math.max(
    ...nodes.map((node) => nodeDisplayName(node).length),
  );
  const agentWidth = Math.max(
    ...nodes.map((node) => (node.agent ?? "ad-hoc").length),
  );
  const rows: string[] = [];
  for (const node of nodes) {
    const icon = STATUS_STYLES[node.status].icon;
    const usage = formatUsage(node.usage);
    const elapsed = formatElapsed(
      (node.endedAt ?? Date.now()) - node.startedAt,
    );
    rows.push(
      [
        `${icon} ${nodeDisplayName(node).padEnd(nameWidth)}`,
        (node.agent ?? "ad-hoc").padEnd(agentWidth),
        node.status.padEnd(9),
        [usage, elapsed].filter(Boolean).join("  "),
      ]
        .join("  ")
        .trimEnd(),
    );
    const preview = formatValuePreview(node.value, 100).replaceAll(/\s+/g, " ");
    if (preview) rows.push(`    ${preview}`);
  }
  lines.push(fenced(rows.join("\n")));
  lines.push("", `Full output: \`/workflow ${id} result <name>\``);
  return lines.join("\n");
}

/** The complete output of one work node, mirroring formatRunResultFull. */
export function formatNodeResultFull(run: RunView, node: NodeView): string {
  const lines = [
    `## Run ${shortId(run.header.id)} — ${nodeDisplayName(node)} (${node.agent ?? "ad-hoc"})`,
    "",
    `- status: ${node.status}${node.cancelReason ? ` (${node.cancelReason})` : ""}`,
  ];
  const usage = formatUsage(node.usage);
  if (usage) lines.push(`- usage: ${usage}`);
  if (node.endedAt)
    lines.push(`- duration: ${formatElapsed(node.endedAt - node.startedAt)}`);
  const steering = node.steering ?? [];
  if (steering.length > 0) {
    lines.push("", "### Steering");
    for (const entry of steering) {
      const source = `${entry.source}${entry.caller ? `:${entry.caller}` : ""}`;
      lines.push(
        "",
        `- ${new Date(entry.at).toISOString()} (${source})`,
        "",
        fenced(entry.message),
      );
    }
  }
  if (node.error) lines.push("", `⚠ ${node.error}`);
  if (node.status === "running") {
    lines.push("", "Still running — no output yet.");
    if (node.progressText) lines.push("", fenced(node.progressText));
    return lines.join("\n");
  }
  // A budget-cut agent has no value, but its last output survives in the
  // events (partialText) or, within this session, in the progress stream.
  const partial = node.partialText ?? node.progressText;
  if (node.status === "failed" && node.value === undefined && partial) {
    lines.push("", "### Partial result", "", fenced(partial));
    return lines.join("\n");
  }
  const text = valueText(node.value);
  if (text === undefined) {
    if (!node.error) lines.push("", "(no output value)");
    return lines.join("\n");
  }
  lines.push("", ...fullValueLines(node.value, text));
  return lines.join("\n");
}

/** Run-argument completion for `/workflow`: id, then verb, then node name after `result`. */
export function completeRunArgs(
  prefix: string,
  runs: RunView[],
): Array<{ value: string; label: string; description?: string }> {
  const tokens = prefix.split(/\s+/);
  const partial = tokens.at(-1) ?? "";
  const done = tokens.slice(0, -1);
  const complete = (
    candidates: Array<{ token: string; description?: string }>,
  ) =>
    candidates
      .filter(({ token }) => token.startsWith(partial))
      .map(({ token, description }) => ({
        value: [...done, token].join(" "),
        label: token,
        description,
      }));
  if (done.length === 0) {
    return complete(
      runs.map((run) => ({
        token: shortId(run.header.id),
        description: `${run.status} — ${run.header.label ?? run.header.flow.kind}`,
      })),
    );
  }
  if (done.length === 1)
    return complete(RUN_ACTIONS.map((action) => ({ token: action })));
  if (done.length === 2 && done[1] === "result") {
    const run = runs.find((r) => r.header.id.startsWith(done[0] ?? ""));
    if (!run) return [];
    return complete(
      workNodes(run).map((node) => ({
        token: nodeDisplayName(node),
        description: node.agent ?? "ad-hoc",
      })),
    );
  }
  return [];
}

export function formatRunDetails(run: RunView, fullValue = false): string {
  const lines = [
    `## Run ${shortId(run.header.id)} — ${run.status}`,
    "",
    `- label: ${run.header.label ?? "(none)"}`,
    `- source: ${formatRunSource(run.header.source)}${run.header.source.workflow ? ` (${run.header.source.workflow})` : ""}`,
    `- started: ${new Date(run.createdAt).toLocaleString()}`,
  ];
  if (run.usage)
    lines.push(
      `- usage: ${formatUsage(run.usage)}${run.agents ? `, ${run.agents} agent(s)` : ""}`,
    );
  if (run.error) lines.push(`- error: ${run.error}`);
  lines.push("", "```", renderRunTree(run) || "(no nodes yet)", "```");
  if (workNodes(run).length > 0)
    lines.push(
      "",
      `Per-agent output: \`/workflow ${shortId(run.header.id)} agents\``,
    );
  if (fullValue) {
    const text = valueText(run.value);
    if (text)
      lines.push("", "### Result", "", ...fullValueLines(run.value, text));
  } else {
    const value = formatValuePreview(run.value);
    if (value) {
      lines.push(
        "",
        "### Result (preview)",
        "",
        `Full result: \`/workflow ${shortId(run.header.id)} result\``,
        "",
        renderResultValue(run.value, value),
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dynamic per-workflow commands

/** Escape braces so user-typed arg values are always literal text. */
function escapeBraces(value: string): string {
  return value.replaceAll("{", "{{").replaceAll("}", "}}");
}

/** Parse `/name` arguments: `key=value` pairs plus positional values bound in declaration order. */
export function parseCommandArgs(
  args: string,
  params: WorkflowParamDef[],
): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const trimmed = args.trim();
  if (!trimmed) return { values, errors };

  // Single-param workflows take the whole arg string verbatim.
  if (params.length === 1 && !/^[A-Za-z_][A-Za-z0-9_-]*=/.test(trimmed)) {
    values[(params[0] as WorkflowParamDef).name] = trimmed;
    return { values, errors };
  }

  const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const positional: string[] = [];
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/s);
    if (match) {
      const key = match[1] as string;
      const value = (match[2] as string).replace(/^"|"$/g, "");
      if (!params.some((param) => param.name === key)) {
        errors.push(
          `unknown parameter '${key}' (declared: ${params.map((p) => p.name).join(", ") || "none"})`,
        );
        continue;
      }
      values[key] = value;
    } else {
      positional.push(token.replace(/^"|"$/g, ""));
    }
  }
  const unfilled = params.filter((param) => values[param.name] === undefined);
  positional.forEach((value, index) => {
    const target = unfilled[index];
    if (target) values[target.name] = value;
    else errors.push(`too many positional arguments (extra: '${value}')`);
  });
  return { values, errors };
}

function usageFor(wf: WorkflowDef): string {
  const argSpec = wf.params
    .map((param) =>
      param.required && param.default === undefined
        ? `<${param.name}>`
        : `[${param.name}]`,
    )
    .join(" ");
  return `Usage: \`/${wf.name}${argSpec ? ` ${argSpec}` : ""}\` — ${wf.description}`;
}

export function registerWorkflowCommands(
  pi: ExtensionAPI,
  cwd: string,
  deps: CommandDeps,
  trusted = true,
): void {
  // Untrusted projects register no commands for their workflows; the
  // invocation-time re-discovery below clamps too, in case trust changes.
  const { workflows } = discoverWorkflows(cwd, trusted ? "both" : "user");
  for (const wf of workflows) {
    if (RESERVED_COMMAND_NAMES.has(wf.name)) continue;
    pi.registerCommand(wf.name, {
      description: `workflow: ${wf.description}`,
      handler: async (args, ctx) =>
        runWorkflowCommand(pi, wf.name, args, ctx, deps),
    });
  }
}

async function runWorkflowCommand(
  pi: ExtensionAPI,
  name: string,
  args: string,
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
): Promise<void> {
  // Re-discover at invocation time so edits to the file apply immediately.
  const { workflows } = discoverWorkflows(ctx.cwd, scopeFor(ctx));
  const wf = resolveWorkflowByName(workflows, name);
  if (!wf) {
    sendInfo(
      pi,
      `Workflow \`${name}\` no longer exists (or fails validation). See \`/workflows\`.`,
    );
    return;
  }
  const { values, errors } = parseCommandArgs(args, wf.params);
  const missing = wf.params.filter(
    (param) =>
      param.required &&
      param.default === undefined &&
      values[param.name] === undefined,
  );
  if (errors.length > 0 || missing.length > 0) {
    const problems = [
      ...errors,
      ...missing.map((param) => `missing required parameter '${param.name}'`),
    ];
    sendInfo(
      pi,
      `${problems.map((p) => `⚠ ${p}`).join("\n")}\n\n${usageFor(wf)}`,
    );
    return;
  }

  const escaped = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, escapeBraces(value)]),
  );
  deps.notifications.setContext(ctx);
  try {
    const flow = validateFlow(
      { kind: "workflow", name: wf.name, params: escaped },
      {
        resolveWorkflow: (candidate) =>
          resolveWorkflowByName(workflows, candidate),
      },
    );
    // Command runs always go to the background; the result arrives as an
    // idle notification.
    const started = startTriggeredRun(deps, {
      flow,
      cwd: ctx.cwd,
      scope: "both",
      label: wf.name,
      source: { kind: "command", workflow: wf.name },
      ctx,
      background: true,
    });
    sendInfo(
      pi,
      `Started run \`${shortId(started.runId)}\` (${wf.name}). Inspect with \`/workflow ${shortId(started.runId)}\`.`,
    );
  } catch (error) {
    sendInfo(pi, `⚠ ${error instanceof Error ? error.message : String(error)}`);
  }
}
