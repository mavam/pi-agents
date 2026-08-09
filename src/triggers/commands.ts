/**
 * Slash commands: the static catalog commands (/agents, /agent, /workflows,
 * /workflow) plus dynamic per-workflow commands (each saved workflow
 * registers /<name>, running its graph directly with the command text bound
 * to its first parameter — no model round-trip). Runs have no top-level command
 * of their own: browse them via /workflows, inspect one via /workflow <run-id>.
 */

import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Agent, discoverAgents } from "../catalog/agents.js";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import type { Scope, WorkflowDef } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { valueText } from "../model/value.js";
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
  formatWorkflowStartPreview,
  nodeDisplayName,
  renderResultValue,
  selectDisplayValue,
  sendInfo,
  shortId,
} from "../ui/render.js";
import { STATUS_STYLES } from "../ui/status.js";
import {
  KIND_ICONS,
  renderFlowTree,
  renderRunTree,
  renderWorkflowTree,
} from "../ui/tree.js";
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

export interface CommandDeps extends TriggerDeps {
  /** Clipboard adapter; defaults to Pi's cross-platform helper. */
  copyText?: (text: string) => Promise<void>;
}

/** Run-inspection verbs accepted by `/workflow <run-id> …`. */
const RUN_ACTIONS = [
  "copy",
  "result",
  "raw",
  "agents",
  "watch",
  "mermaid",
  "stop",
] as const;

/** Discovery scope for a context: untrusted projects contribute nothing. */
function scopeFor(ctx: Pick<ExtensionContext, "isProjectTrusted">): Scope {
  return isProjectTrusted(ctx as ExtensionContext) ? "both" : "user";
}

/** Explain why a workflow cannot be represented by one command argument. */
function directCommandBlocker(
  wf: Pick<WorkflowDef, "name" | "params">,
): string | undefined {
  const required = wf.params
    .slice(1)
    .filter((param) => param.required && param.default === undefined);
  if (required.length === 0) return undefined;
  return `/${wf.name} requires additional named parameters: ${required.map((param) => param.name).join(", ")}. Use the workflow tool or RPC to supply them.`;
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
        await openOverlay(ctx, buildWorkflowsSpec(pi, deps, ctx), deps.widget);
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
      "Show a workflow, or inspect a run: /workflow <name>, /workflow <run-id> [copy|result [node]|raw|agents|watch|mermaid|stop]",
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
      const usage =
        "Usage: `/workflow <name>` or `/workflow <run-id> [copy|result [node]|raw|agents|watch|mermaid|stop]`";
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const [target, verb, nodeRef, ...extra] = tokens;
      const action = RUN_ACTIONS.find((candidate) => candidate === verb);
      if (!target) {
        sendInfo(pi, usage);
        return;
      }
      if (
        (verb !== undefined && action === undefined) ||
        (nodeRef !== undefined && action !== "result") ||
        extra.length > 0
      ) {
        sendInfo(pi, usage);
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
      if (action === "copy") {
        if (nodeRef) {
          sendInfo(
            pi,
            "Usage: `/workflow <run-id> copy` — `copy` applies to the run's final presented result.",
          );
          return;
        }
        if (ctx.mode !== "tui") {
          sendInfo(
            pi,
            "`/workflow <run-id> copy` is available only in the TUI.",
          );
          return;
        }
        await copyRunResult(run, deps, ctx);
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
      if (action === "raw") {
        sendInfo(pi, formatRunRawResult(run));
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
  const output = valueText(node.value);
  const lines = output
    ? output.split("\n")
    : [color("dim", "(no output value)")];
  lines.push("", color("dim", "⏎ post full output"));
  return [...steering, ...(steering.length > 0 ? [""] : []), ...lines];
}

function canTailNode(node: NodeView): boolean {
  return (
    node.status === "running" ||
    node.progressTail !== undefined ||
    node.progressText !== undefined
  );
}

function nodeTailDetail(node: NodeView, color: Colorize): string[] {
  const lines: string[] = [];
  if (node.steering.length > 0) {
    lines.push(color("accent", "steering"));
    for (const entry of node.steering) {
      lines.push(
        ...entry.message
          .split("\n")
          .map((line, index) =>
            color(
              "accent",
              index === 0 ? `${steeringMarker(entry)} ${line}` : `  ${line}`,
            ),
          ),
      );
    }
    lines.push("");
  }

  const tail = node.progressTail ?? node.progressText;
  if (!tail) {
    lines.push(
      color(
        "dim",
        node.status === "running"
          ? "waiting for output…"
          : "(no live activity retained)",
      ),
    );
    return lines;
  }
  for (const [index, entry] of tail.split("\n\n").entries()) {
    if (index > 0) lines.push("");
    const [header = "", ...body] = entry.split("\n");
    if (header.startsWith("assistant ·")) lines.push(color("muted", header));
    else if (header.startsWith("✗ ")) lines.push(color("error", header));
    else if (header.startsWith("✓ ")) lines.push(color("success", header));
    else if (header.startsWith("› ")) lines.push(color("warning", header));
    else lines.push(header);
    lines.push(...body);
  }
  return lines;
}

function runDetail(run: RunView, color: Colorize): string[] {
  const lines = (renderRunTree(run, color) || "(no nodes yet)").split("\n");
  if (run.error) lines.push(color("error", `✗ ${run.error}`));
  const display = selectDisplayValue(run.value, run.header.display);
  const value = run.status !== "running" ? valueText(display.value) : undefined;
  if (run.status === "completed" && display.warning)
    lines.push(color("warning", `⚠ ${display.warning}`));
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

/** Whether a settled run has a presented value worth copying. */
function canCopyRunResult(run: RunView): boolean {
  if (run.status === "running") return false;
  const display = selectDisplayValue(run.value, run.header.display);
  return display.value !== undefined && display.value !== "";
}

/** Copy only the human-facing value selected for this run. */
async function copyRunResult(
  run: RunView,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (run.status === "running") {
    ctx.ui.notify(
      `Run ${shortId(run.header.id)} is still running — no final result to copy.`,
      "warning",
    );
    return;
  }
  const display = selectDisplayValue(run.value, run.header.display);
  const text = valueText(display.value);
  if (!text) {
    ctx.ui.notify(
      `Run ${shortId(run.header.id)} has no result to copy.`,
      "warning",
    );
    return;
  }
  try {
    await (deps.copyText ?? copyToClipboard)(text);
    const copied = `Copied run ${shortId(run.header.id)} result to clipboard.`;
    ctx.ui.notify(
      display.warning ? `${display.warning} ${copied}` : copied,
      display.warning ? "warning" : "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not copy run ${shortId(run.header.id)} result: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function runFooter(run: RunView): string {
  const copyOrCancel =
    run.status === "running"
      ? " · c cancel"
      : canCopyRunResult(run)
        ? " · c copy"
        : "";
  return `↑↓ move · ⏎ inspect · a agents${copyOrCancel} · r rerun · h hide · esc back`;
}

/** Run-tier actions: post details, copy or cancel, hide, and rerun. */
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
    if (run.status === "running") {
      const stopped = deps.manager.stop(run.header.id);
      ctx.ui.notify(
        stopped
          ? `Stopping run ${shortId(run.header.id)}…`
          : "Run is not live.",
        stopped ? "info" : "warning",
      );
    } else if (canCopyRunResult(run)) {
      void copyRunResult(run, deps, ctx);
    }
    return undefined;
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
        display: run.header.display,
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
  let tailNodeInstance: string | undefined;
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
  const tailedNode = (): NodeView | undefined =>
    tailNodeInstance ? drilledRun()?.nodes.get(tailNodeInstance) : undefined;
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
      const node = tailedNode();
      if (run && node)
        return `${node.status === "running" ? "Live tail" : "Tail"} · ${shortId(run.header.id)} · ${nodeDisplayName(node)}`;
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
      tailNodeInstance
        ? "⏎ post output · t agents · esc back"
        : drillRunId
          ? "↑↓ move · ⏎ post output · t tail · esc back"
          : drillGroup
            ? "↑↓ move · ⏎ inspect · a agents · r rerun · h hide · esc back"
            : "↑↓ move · ⏎ runs · c compose · r run · n new · esc close",
    footerFor: (item) => {
      if (item.kind === "node") {
        const steerable = deps.manager
          .steerableInstances(item.run.header.id)
          .includes(item.node.instance);
        const tailing = tailNodeInstance === item.node.instance;
        return tailing
          ? `⏎ post output${steerable ? " · s steer" : ""} · t agents · esc back`
          : `↑↓ move · ⏎ post output${canTailNode(item.node) ? " · t tail" : ""}${steerable ? " · s steer" : ""} · esc back`;
      }
      if (item.kind === "run") return runFooter(item.run);
      if (item.kind === "workflow")
        return "↑↓ move · ⏎ runs · c compose · r run · n new · esc close";
      return "↑↓ move · ⏎ runs · n new · esc close";
    },
    items: () => {
      const run = drilledRun();
      if (run) {
        const nodes = workNodes(run);
        if (tailNodeInstance) {
          const node = nodes.find(
            (candidate) => candidate.instance === tailNodeInstance,
          );
          if (node) return [{ kind: "node" as const, run, node }];
          tailNodeInstance = undefined;
        }
        return nodes.map((node) => ({
          kind: "node" as const,
          run,
          node,
        }));
      }
      tailNodeInstance = undefined;
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
      if (item.kind === "node")
        return tailNodeInstance === item.node.instance
          ? nodeTailDetail(item.node, color)
          : nodeDetail(item.node, color);
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
        if (wf.display) lines.push(meta("display", wf.display));
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
        lines.push(
          "",
          ...renderWorkflowTree(wf.name, wf.flow, color).split("\n"),
        );
        return lines;
      }
      const recent = groupRuns(item.kind).reverse().slice(0, 8);
      return recent.length > 0
        ? recent.map((run) => formatRunOverviewLine(run))
        : [color("dim", "(no runs yet)")];
    },
    detailWindow: (item) =>
      item.kind === "node" && tailNodeInstance === item.node.instance
        ? "tail"
        : "head",
    onAction: (key, item) => {
      if (item.kind === "node") {
        if (key === "t") {
          if (tailNodeInstance === item.node.instance) {
            tailNodeInstance = undefined;
          } else if (canTailNode(item.node)) {
            tailNodeInstance = item.node.instance;
          } else {
            return undefined;
          }
          return { selectKey: nodeKey(item.run, item.node) };
        }
        return nodeAction(key, item.run, item.node, pi, deps, ctx);
      }
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
      const compose = (): "close" => {
        // Non-overlay custom UI restores the editor text it captured when the
        // panel opened. Defer the prefill until after that teardown so the
        // restored snapshot does not overwrite the workflow command.
        setTimeout(() => ctx.ui.setEditorText(`/${item.wf.name} `), 0);
        return "close";
      };
      const blocker = directCommandBlocker(item.wf);
      const warnBlocked = (): undefined => {
        if (blocker) ctx.ui.notify(blocker, "warning");
        return undefined;
      };
      if (key === "c") return blocker ? warnBlocked() : compose();
      if (key === "r") {
        if (blocker) return warnBlocked();
        const parameter = item.wf.params[0];
        if (parameter?.required && parameter.default === undefined) {
          ctx.ui.notify(`/${item.wf.name} needs: ${parameter.name}`, "warning");
          return compose();
        }
        void runWorkflowCommand(pi, item.wf.name, "", ctx, deps);
        // Stay open, like the run tier's rerun: live() is true while the run
        // is running, so the row's badge tracks it here and `enter` drills in
        // to watch the tree. Closing would drop the user at the composer with
        // only the live summary — which this panel supersedes.
        return undefined;
      }
      return undefined;
    },
    onCancel: () => {
      if (tailNodeInstance) {
        const run = drilledRun();
        const node = tailedNode();
        tailNodeInstance = undefined;
        return run && node ? { selectKey: nodeKey(run, node) } : undefined;
      }
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
  if (wf.display) lines.push(`- display: \`${wf.display}\``);
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
  lines.push(
    "",
    "### Flow",
    "",
    "```",
    renderWorkflowTree(wf.name, wf.flow),
    "```",
  );
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

/** The complete human-facing run value selected by the workflow's display path. */
function formatRunResultFull(run: RunView): string {
  const lines = [`## Run ${shortId(run.header.id)} — result`, ""];
  if (run.status === "running") {
    lines.push("Still running — no result yet.");
    return lines.join("\n");
  }
  if (run.error) lines.push(`⚠ ${run.error}`, "");
  const display = selectDisplayValue(run.value, run.header.display);
  const text = valueText(display.value);
  if (run.status === "completed" && display.warning)
    lines.push(`> ⚠ ${display.warning}`, "");
  if (text === undefined) {
    lines.push("(no result value)");
    return lines.join("\n");
  }
  lines.push(renderResultValue(display.value, text));
  if (display.selected)
    lines.push("", `Raw data: \`/workflow ${shortId(run.header.id)} raw\``);
  return lines.join("\n");
}

/** The complete persisted run value serialized as JSON. */
function formatRunRawResult(run: RunView): string {
  const lines = [`## Run ${shortId(run.header.id)} — raw`, ""];
  if (run.status === "running") {
    lines.push("Still running — no result yet.");
    return lines.join("\n");
  }
  if (run.error) lines.push(`⚠ ${run.error}`, "");
  const text =
    run.value === undefined ? undefined : JSON.stringify(run.value, null, 2);
  if (text === undefined) {
    lines.push("(no result value)");
    return lines.join("\n");
  }
  lines.push(fenced(text, "json"));
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
  lines.push("", renderResultValue(node.value, text));
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
  if (run.header.display) lines.push(`- display: \`${run.header.display}\``);
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
  const display = selectDisplayValue(run.value, run.header.display);
  if (run.status === "completed" && display.warning)
    lines.push("", `> ⚠ ${display.warning}`);
  if (fullValue || display.selected) {
    const text = valueText(display.value);
    if (text)
      lines.push("", "### Result", "", renderResultValue(display.value, text));
  } else {
    const value = formatValuePreview(display.value);
    if (value) {
      lines.push(
        "",
        "### Result (preview)",
        "",
        renderResultValue(display.value, value),
      );
    }
  }
  if (run.value !== undefined)
    lines.push("", `Raw data: \`/workflow ${shortId(run.header.id)} raw\``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dynamic per-workflow commands

/** Escape braces so user-typed arg values are always literal text. */
function escapeBraces(value: string): string {
  return value.replaceAll("{", "{{").replaceAll("}", "}}");
}

function usageFor(wf: WorkflowDef): string {
  const param = wf.params[0];
  const argSpec = param
    ? param.required && param.default === undefined
      ? `<${param.name}>`
      : `[${param.name}]`
    : "";
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
  const argument = args.trim();
  const parameter = wf.params[0];
  const blocker = directCommandBlocker(wf);
  if (blocker) {
    sendInfo(pi, `⚠ ${blocker}`);
    return;
  }
  if (!parameter && argument) {
    sendInfo(
      pi,
      `⚠ \`/${wf.name}\` does not accept an argument.\n\n${usageFor(wf)}`,
    );
    return;
  }
  if (
    parameter?.required &&
    parameter.default === undefined &&
    argument === ""
  ) {
    sendInfo(
      pi,
      `⚠ missing required argument '${parameter.name}'\n\n${usageFor(wf)}`,
    );
    return;
  }
  const values: Record<string, string> =
    parameter && argument ? { [parameter.name]: argument } : {};

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
      display: wf.display,
      source: { kind: "command", workflow: wf.name },
      ctx,
      background: true,
    });
    const savedFlowTree = renderFlowTree(flow);
    sendInfo(
      pi,
      formatWorkflowStartPreview(
        { name: wf.name, params: values },
        started.runId,
        savedFlowTree,
      ),
    );
  } catch (error) {
    sendInfo(pi, `⚠ ${error instanceof Error ? error.message : String(error)}`);
  }
}
