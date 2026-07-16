/**
 * Slash commands: the static catalog/run commands (/agents, /agent,
 * /workflows, /workflow, /runs, /run) plus dynamic per-workflow commands
 * (each saved workflow registers /<name>, running its graph directly with
 * args bound to params — no model round-trip).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../catalog/agents.js";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import type { WorkflowDef, WorkflowParamDef } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import type { RunView } from "../run/state.js";
import { toMermaid } from "../ui/mermaid.js";
import {
  formatRunOverviewLine,
  formatRunTree,
  formatUsage,
  formatValuePreview,
  sendInfo,
  shortId,
} from "../ui/render.js";
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

// ---------------------------------------------------------------------------
// Static commands

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("agents", {
    description: "List discovered agents",
    handler: async (_args, ctx) => {
      const discovery = discoverAgents(ctx.cwd, "both");
      const lines = ["## Agents", ""];
      if (discovery.agents.length === 0) {
        lines.push(
          "No agents found. Create `.pi/agents/<name>.md` or `~/.pi/agents/<name>.md`.",
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
      const discovery = discoverAgents(ctx.cwd, "both");
      const agent = discovery.agents.find((a) => a.name === name);
      if (!agent) {
        sendInfo(pi, `Unknown agent \`${name}\`. Try \`/agents\`.`);
        return;
      }
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
      if (agent.tools) lines.push(`- tools: ${agent.tools.join(", ")}`);
      lines.push(
        "",
        "### System prompt",
        "",
        "```",
        agent.systemPrompt || "(empty)",
        "```",
      );
      sendInfo(pi, lines.join("\n"));
    },
  });

  pi.registerCommand("workflows", {
    description: "List saved workflows",
    handler: async (_args, ctx) => {
      const { workflows, diagnostics } = discoverWorkflows(ctx.cwd, "both");
      const lines = ["## Workflows", ""];
      if (workflows.length === 0) {
        lines.push(
          "No workflows found. Create `.pi/workflows/<name>.md` or `~/.pi/workflows/<name>.md`.",
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
      const { workflows } = discoverWorkflows(ctx.cwd, "both");
      const wf = resolveWorkflowByName(workflows, name);
      if (!wf) {
        sendInfo(pi, `Unknown workflow \`${name}\`. Try \`/workflows\`.`);
        return;
      }
      sendInfo(pi, formatWorkflowDetails(wf));
    },
  });

  pi.registerCommand("runs", {
    description: "Browse workflow runs",
    handler: async () => {
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
    description: "Inspect a run: /run <id> [stop]",
    getArgumentCompletions: (prefix) => {
      return [...deps.manager.state.runs.values()]
        .filter((run) => run.header.id.startsWith(prefix))
        .map((run) => ({
          value: shortId(run.header.id),
          label: shortId(run.header.id),
          description: `${run.status} — ${run.header.label ?? run.header.flow.kind}`,
        }));
    },
    handler: async (args) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.find((t) =>
        ["stop", "watch", "mermaid"].includes(t),
      );
      const idOrPrefix = tokens.find(
        (t) => !["stop", "watch", "mermaid"].includes(t),
      );
      if (!idOrPrefix) {
        sendInfo(pi, "Usage: `/run <id> [stop]`");
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

function formatWorkflowDetails(wf: WorkflowDef): string {
  const lines = [
    `## /${wf.name} (${wf.source})`,
    "",
    wf.description,
    "",
    `- file: ${wf.filePath}`,
  ];
  if (wf.whenToUse) lines.push(`- when to use: ${wf.whenToUse}`);
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
    "```json",
    JSON.stringify(wf.flow, null, 2),
    "```",
  );
  return lines.join("\n");
}

function formatRunDetails(run: RunView): string {
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
  lines.push("", "```", formatRunTree(run) || "(no nodes yet)", "```");
  const value = formatValuePreview(run.value);
  if (value) lines.push("", "### Result", "", "```", value, "```");
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
): void {
  const { workflows, diagnostics } = discoverWorkflows(cwd, "both");
  for (const diagnostic of diagnostics) {
    // Surfaced in /workflows too; avoid noisy startup output.
    void diagnostic;
  }
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
  const { workflows } = discoverWorkflows(ctx.cwd, "both");
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
