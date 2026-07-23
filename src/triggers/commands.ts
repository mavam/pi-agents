/**
 * Slash commands: the static catalog/run commands (/agents, /agent,
 * /workflows, /workflow, /runs, /run) plus dynamic per-workflow commands
 * (each saved workflow registers /<name>, running its graph directly with
 * args bound to params — no model round-trip).
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
import { type NodeView, type RunView, workNodes } from "../run/state.js";
import { toMermaid } from "../ui/mermaid.js";
import { type OverlaySpec, openOverlay } from "../ui/overlay.js";
import {
  fenced,
  formatRunOverviewLine,
  formatUsage,
  formatValuePreview,
  nodeDisplayName,
  STATUS_ICONS,
  sendInfo,
  shortId,
} from "../ui/render.js";
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

/** Verbs accepted by `/run <id> …`. */
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
      "Browse saved workflows (interactive in the TUI; `list` for text)",
    getArgumentCompletions: (prefix) =>
      ["list"]
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => ({ value: arg, label: arg })),
    handler: async (args, ctx) => {
      if (ctx.hasUI && ctx.mode === "tui" && args.trim() !== "list") {
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
    description: "Show details for one saved workflow",
    getArgumentCompletions: (prefix) => {
      const { workflows } = discoverWorkflows(process.cwd(), "both");
      return workflows
        .filter((wf) => wf.name.startsWith(prefix))
        .map((wf) => ({
          value: wf.name,
          label: wf.name,
          description: wf.description,
        }));
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        sendInfo(pi, "Usage: `/workflow <name>`");
        return;
      }
      const { workflows } = discoverWorkflows(ctx.cwd, scopeFor(ctx));
      const wf = resolveWorkflowByName(workflows, name);
      if (!wf) {
        sendInfo(pi, `Unknown workflow \`${name}\`. Try \`/workflows\`.`);
        return;
      }
      sendInfo(pi, formatWorkflowDetails(wf));
    },
  });

  pi.registerCommand("runs", {
    description:
      "Browse workflow runs (interactive in the TUI; `list` for text, `widget` to toggle the live summary)",
    getArgumentCompletions: (prefix) =>
      ["list", "widget"]
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
      if (ctx.hasUI && ctx.mode === "tui" && arg !== "list") {
        await openOverlay(ctx, buildRunsSpec(pi, deps, ctx));
        return;
      }
      const runs = [...deps.manager.state.runs.values()];
      if (runs.length === 0) {
        sendInfo(pi, "No runs yet.");
        return;
      }
      const lines = ["## Runs", "", "```"];
      for (const run of runs.slice(-30)) {
        lines.push(formatRunOverviewLine(run));
      }
      lines.push("```", "", "Inspect one with `/run <id>`.");
      sendInfo(pi, lines.join("\n"));
    },
  });

  pi.registerCommand("run", {
    description:
      "Inspect a run: /run <id> [result [node]|agents|watch|mermaid|stop]",
    getArgumentCompletions: (prefix) =>
      completeRunArgs(prefix, [...deps.manager.state.runs.values()]),
    handler: async (args) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.find((t) => RUN_ACTIONS.includes(t));
      const [idOrPrefix, nodeRef] = tokens.filter(
        (t) => !RUN_ACTIONS.includes(t),
      );
      if (!idOrPrefix) {
        sendInfo(
          pi,
          "Usage: `/run <id> [result [node]|agents|watch|mermaid|stop]`",
        );
        return;
      }
      const lookup = deps.manager.find(idOrPrefix);
      if (lookup.kind === "missing") {
        sendInfo(pi, `No run matching \`${idOrPrefix}\`. Try \`/runs\`.`);
        return;
      }
      if (lookup.kind === "ambiguous") {
        sendInfo(
          pi,
          `Ambiguous run id \`${idOrPrefix}\`: ${lookup.matches.map((run) => shortId(run.header.id)).join(", ")}`,
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

const STATUS_COLORS: Record<string, Parameters<Colorize>[0]> = {
  running: "warning",
  completed: "success",
  failed: "error",
  cancelled: "dim",
  stopped: "dim",
};

/** Overlay rows: top-level runs, or one run's work nodes when drilled in. */
type RunsItem =
  | { kind: "run"; run: RunView }
  | { kind: "node"; run: RunView; node: NodeView };

function buildRunsSpec(
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): OverlaySpec<RunsItem> {
  // Drill-down is a mode switch, not a nested overlay: ctx.ui.custom shows a
  // single focused component, so items()/chrome/actions branch on this id.
  let drillRunId: string | undefined;
  const drilledRun = (): RunView | undefined =>
    drillRunId ? deps.manager.state.runs.get(drillRunId) : undefined;
  const nodeKey = (run: RunView, node: NodeView) =>
    `node:${run.header.id}:${node.instance}`;
  return {
    title: () => {
      const run = drilledRun();
      return run ? `Run ${shortId(run.header.id)} · agents` : "Runs";
    },
    emptyText: () => (drillRunId ? "No agents started yet." : "No runs yet."),
    footer: () =>
      drillRunId
        ? "↑↓ move · ⏎ post output · esc back"
        : "↑↓ move · ⏎ inspect · a agents · c cancel · r rerun · h hide · esc close",
    items: () => {
      const run = drilledRun();
      if (run)
        return workNodes(run).map((node) => ({
          kind: "node" as const,
          run,
          node,
        }));
      drillRunId = undefined; // Drilled run evicted: back to the run list.
      return [...deps.manager.state.runs.values()]
        .reverse()
        .map((r) => ({ kind: "run" as const, run: r }));
    },
    keyOf: (item) =>
      item.kind === "run"
        ? `run:${item.run.header.id}`
        : nodeKey(item.run, item.node),
    row: (item, color) => {
      if (item.kind === "node") {
        const { node } = item;
        const icon = color(
          STATUS_COLORS[node.status] ?? "dim",
          STATUS_ICONS[node.status] ?? "?",
        );
        const usage = formatUsage(
          node.usage ??
            (node.status === "running" ? node.progressUsage : undefined),
        );
        return `${icon} ${nodeDisplayName(node).padEnd(12)}  ${(node.agent ?? "ad-hoc").padEnd(10)}  ${node.status.padEnd(9)}${usage ? `  ${color("dim", usage)}` : ""}`;
      }
      const run = item.run;
      const icon = color(
        STATUS_COLORS[run.status] ?? "dim",
        STATUS_ICONS[run.status] ?? "?",
      );
      const label =
        run.header.label ?? run.header.source.workflow ?? run.header.flow.kind;
      const source =
        run.header.source.kind === "hook"
          ? `hook:${run.header.source.event ?? "?"}`
          : run.header.source.kind;
      const usage = formatUsage(run.usage);
      const hidden = deps.widget.isHidden(run.header.id)
        ? color("dim", "  ⊘ hidden")
        : "";
      return `${icon} ${color("dim", shortId(run.header.id))}  ${run.status.padEnd(9)}  ${`${label} (${source})`.padEnd(24)}${usage ? `  ${color("dim", usage)}` : ""}${hidden}`;
    },
    headerLine: (item, color) => {
      const parts =
        item.kind === "node"
          ? [
              shortId(item.run.header.id),
              nodeDisplayName(item.node),
              item.node.agent ?? "ad-hoc",
              formatElapsed(
                (item.node.endedAt ?? Date.now()) - item.node.startedAt,
              ),
              formatUsage(item.node.usage) || undefined,
            ]
          : [
              shortId(item.run.header.id),
              item.run.header.label ?? item.run.header.flow.kind,
              formatElapsed(
                (item.run.endedAt ?? Date.now()) - item.run.createdAt,
              ),
              formatUsage(item.run.usage) || undefined,
            ];
      return parts
        .filter((part): part is string => part !== undefined)
        .join(color("dim", " · "));
    },
    detail: (item, color) => {
      if (item.kind === "node") {
        const { node } = item;
        if (node.error) return [color("error", `✗ ${node.error}`)];
        if (node.status === "cancelled")
          return [
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
            ? tail.map((line) => color("dim", line))
            : [color("dim", "running…")];
        }
        const preview = formatValuePreview(node.value, 600);
        const lines = preview
          ? preview.split("\n")
          : [color("dim", "(no output value)")];
        lines.push("", color("dim", "⏎ post full output"));
        return lines;
      }
      const run = item.run;
      const lines = (renderRunTree(run, color) || "(no nodes yet)").split("\n");
      if (run.error) lines.push(color("error", `✗ ${run.error}`));
      const value =
        run.status !== "running" ? formatValuePreview(run.value, 300) : "";
      if (value) lines.push("", ...value.split("\n"));
      return lines;
    },
    onAction: (key, item) => {
      if (item.kind === "node") {
        if (key === "enter") {
          sendInfo(pi, formatNodeResultFull(item.run, item.node));
          return "close";
        }
        return undefined;
      }
      const run = item.run;
      if (key === "enter") {
        sendInfo(pi, formatRunDetails(run, true));
        return "close";
      }
      if (key === "a") {
        drillRunId = run.header.id;
        const first = workNodes(run)[0];
        return first ? { selectKey: nodeKey(run, first) } : undefined;
      }
      if (key === "c") {
        const stopped = deps.manager.stop(run.header.id);
        ctx.ui.notify(
          stopped
            ? `Stopping run ${shortId(run.header.id)}…`
            : "Run is not live.",
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
    },
    onCancel: () => {
      if (!drillRunId) return "close";
      const id = drillRunId;
      drillRunId = undefined;
      return { selectKey: `run:${id}` };
    },
    live: () =>
      [...deps.manager.state.runs.values()].some(
        (run) => run.status === "running",
      ),
  };
}

function buildWorkflowsSpec(
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): OverlaySpec<WorkflowDef> {
  return {
    title: "Workflows",
    emptyText:
      "No workflows found. Create .pi/workflows/<name>.yaml or ~/.pi/agent/workflows/<name>.yaml.",
    footer: "↑↓ move · ⏎ compose · r run · n new · esc close",
    items: () => discoverWorkflows(ctx.cwd, scopeFor(ctx)).workflows,
    keyOf: (wf) => `${wf.source}:${wf.name}`,
    row: (wf, color) => {
      const triggers =
        wf.on && wf.on.length > 0
          ? color("dim", `  on: ${wf.on.join(", ")}`)
          : "";
      return `${color("muted", KIND_ICONS.workflow)} ${`/${wf.name}`.padEnd(16)}  ${color("dim", wf.source.padEnd(7))}  ${wf.description}${triggers}`;
    },
    headerLine: (wf, color) => {
      return [`/${wf.name}`, wf.source].join(color("dim", " · "));
    },
    detail: (wf, color) => {
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
    },
    onAction: (key, wf) => {
      if (key === "enter") {
        ctx.ui.setEditorText(`/${wf.name} `);
        return "close";
      }
      if (key === "r") {
        const missing = wf.params.filter(
          (param) => param.required && param.default === undefined,
        );
        if (missing.length > 0) {
          ctx.ui.setEditorText(`/${wf.name} `);
          ctx.ui.notify(
            `/${wf.name} needs: ${missing.map((param) => param.name).join(", ")}`,
            "warning",
          );
          return "close";
        }
        void runWorkflowCommand(pi, wf.name, "", ctx, deps);
        return "close";
      }
      if (key === "n") {
        // Defer past the overlay teardown so the input dialogs get focus.
        setTimeout(() => void newDefinitionWizard(pi, ctx), 0);
        return "close";
      }
    },
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

/** Fenced full value, bounded by MAX_FULL_RESULT_CHARS. */
function fullValueLines(text: string): string[] {
  if (text.length > MAX_FULL_RESULT_CHARS) {
    return [
      fenced(text.slice(0, MAX_FULL_RESULT_CHARS)),
      "",
      `… truncated ${text.length - MAX_FULL_RESULT_CHARS} characters.`,
    ];
  }
  return [fenced(text)];
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
  lines.push(...fullValueLines(text));
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
    const icon = STATUS_ICONS[node.status] ?? "?";
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
  lines.push("", `Full output: \`/run ${id} result <name>\``);
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
  if (node.error) lines.push("", `⚠ ${node.error}`);
  if (node.status === "running") {
    lines.push("", "Still running — no output yet.");
    if (node.progressText) lines.push("", fenced(node.progressText));
    return lines.join("\n");
  }
  const text = valueText(node.value);
  if (text === undefined) {
    if (!node.error) lines.push("", "(no output value)");
    return lines.join("\n");
  }
  lines.push("", ...fullValueLines(text));
  return lines.join("\n");
}

/** Argument completion for `/run`: id, then verb, then node name after `result`. */
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

function formatRunDetails(run: RunView, fullValue = false): string {
  const lines = [
    `## Run ${shortId(run.header.id)} — ${run.status}`,
    "",
    `- label: ${run.header.label ?? "(none)"}`,
    `- source: ${run.header.source.kind}${run.header.source.workflow ? ` (${run.header.source.workflow})` : ""}${run.header.source.event ? ` on ${run.header.source.event}` : ""}`,
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
      `Per-agent output: \`/run ${shortId(run.header.id)} agents\``,
    );
  if (fullValue) {
    const text = valueText(run.value);
    if (text) lines.push("", "### Result", "", ...fullValueLines(text));
  } else {
    const value = formatValuePreview(run.value);
    if (value) {
      lines.push("", "### Result (preview)", "", fenced(value));
      lines.push("", `Full result: \`/run ${shortId(run.header.id)} result\``);
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
      `Started run \`${shortId(started.runId)}\` (${wf.name}). Inspect with \`/run ${shortId(started.runId)}\`.`,
    );
  } catch (error) {
    sendInfo(pi, `⚠ ${error instanceof Error ? error.message : String(error)}`);
  }
}
