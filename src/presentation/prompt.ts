/**
 * System-prompt catalogs injected via before_agent_start: the agent catalog
 * (from agents.ts) plus a compact workflow catalog — name, description,
 * trigger, and params only, never flow bodies.
 */

import {
  type AgentAvailability,
  buildAgentsPrompt,
} from "../catalog/agents.js";
import { type ModelNoteRule, resolveModelNote } from "../catalog/config.js";
import type { ModelCatalog, ModelCatalogEntry } from "../catalog/models.js";
import { discoverWorkflows } from "../catalog/workflows.js";
import type { Scope } from "../model/ast.js";

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export const MODELS_PROMPT_BUDGET = 4_096;

function modeOf<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function costTier(costOut: number | undefined): string | undefined {
  if (costOut === undefined) return undefined;
  if (costOut < 2) return "$";
  if (costOut < 10) return "$$";
  return "$$$";
}

function contextLabel(ctx: number): string {
  if (ctx >= 1_000_000) return `${Number((ctx / 1_000_000).toFixed(1))}m ctx`;
  return `${Math.round(ctx / 1_000)}k ctx`;
}

function renderModel(
  providerId: string,
  model: ModelCatalogEntry,
  modes: { ctx?: number },
  notes: readonly ModelNoteRule[],
  options: { notes: boolean; deviations: boolean; tiers: boolean },
): string {
  const annotations: string[] = [];
  if (options.tiers) {
    const tier = costTier(model.costOut);
    if (tier) annotations.push(tier);
  }
  if (options.deviations) {
    if (
      model.ctx !== undefined &&
      modes.ctx !== undefined &&
      model.ctx !== modes.ctx
    )
      annotations.push(contextLabel(model.ctx));
  }
  const note = options.notes
    ? resolveModelNote(notes, `${providerId}/${model.id}`)
    : undefined;
  if (annotations.length === 0 && !note) return model.id;
  const metadata = note
    ? `${annotations.join(", ")}${annotations.length > 0 ? " — " : ""}${note}`
    : annotations.join(", ");
  return `${model.id} (${metadata})`;
}

function renderModelsPrompt(
  catalog: ModelCatalog,
  notes: readonly ModelNoteRule[],
  options: { notes: boolean; deviations: boolean; tiers: boolean },
): string {
  const note = [
    "valid values for agent-node 'model' (omit to inherit the session model); when an id exists under several providers, prefer the earlier provider",
    options.tiers
      ? "$..$$$ are price tiers (cheap..premium), not quality; subscription tiers indicate quota burn; prefer $ for mechanical subtasks and $$$ for planning, review, and reduce"
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  const lines = [`<models note="${escapeXmlAttribute(note)}">`];
  if (catalog.providers.length === 0) {
    lines.push("  <none>No available models were discovered.</none>");
  } else {
    for (const provider of catalog.providers) {
      const auth = provider.subscription ? "subscription" : "api-key";
      const modes = {
        ctx: modeOf(
          provider.models.flatMap((model) =>
            model.ctx === undefined ? [] : [model.ctx],
          ),
        ),
      };
      const models = provider.models.map((model) =>
        renderModel(provider.id, model, modes, notes, options),
      );
      lines.push(
        `  <provider id="${escapeXmlAttribute(provider.id)}" auth="${auth}">${escapeXmlText(models.join(", "))}</provider>`,
      );
    }
  }
  lines.push("</models>");
  return lines.join("\n");
}

export function buildModelsPrompt(
  catalog: ModelCatalog,
  notes: readonly ModelNoteRule[] = [],
): string {
  const attempts = [
    { notes: true, deviations: true, tiers: true },
    { notes: false, deviations: true, tiers: true },
    { notes: false, deviations: false, tiers: true },
    { notes: false, deviations: false, tiers: false },
  ];
  for (const options of attempts) {
    const prompt = renderModelsPrompt(catalog, notes, options);
    if (prompt.length <= MODELS_PROMPT_BUDGET) return prompt;
  }
  // The id list is the contract and is never truncated, even if a future
  // registry grows beyond the annotation budget by itself.
  return renderModelsPrompt(
    catalog,
    [],
    attempts.at(-1) as (typeof attempts)[number],
  );
}

export function buildWorkflowsPrompt(
  cwd: string,
  scope: Scope = "both",
): string {
  const { workflows, diagnostics } = discoverWorkflows(cwd, scope);
  const lines = [`<workflows cwd="${escapeXmlAttribute(cwd)}">`];
  if (workflows.length === 0) {
    lines.push("  <none>No saved workflows were discovered.</none>");
  } else {
    for (const wf of workflows) {
      lines.push(
        `  <workflow name="${escapeXmlAttribute(wf.name)}" source="${escapeXmlAttribute(wf.source)}">`,
      );
      lines.push(
        `    <description>${escapeXmlText(wf.description)}</description>`,
      );
      if (wf.trigger) {
        lines.push(`    <trigger>${escapeXmlText(wf.trigger)}</trigger>`);
      }
      if (wf.params.length > 0) {
        lines.push("    <params>");
        for (const param of wf.params) {
          const attrs = [
            `name="${escapeXmlAttribute(param.name)}"`,
            param.required ? 'required="true"' : undefined,
            param.default !== undefined
              ? `default="${escapeXmlAttribute(param.default)}"`
              : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          lines.push(
            `      <param ${attrs}>${escapeXmlText(param.description ?? "")}</param>`,
          );
        }
        lines.push("    </params>");
      }
      lines.push("  </workflow>");
    }
  }
  if (diagnostics.length > 0) {
    lines.push("  <diagnostics>");
    for (const diagnostic of diagnostics) {
      lines.push(
        `    <diagnostic path="${escapeXmlAttribute(diagnostic.filePath)}">${escapeXmlText(diagnostic.message)}</diagnostic>`,
      );
    }
    lines.push("  </diagnostics>");
  }
  lines.push("</workflows>");
  return lines.join("\n");
}

/** The full appendix injected into the system prompt every turn. */
export function buildSystemPromptAppendix(
  cwd: string,
  trusted = true,
  catalog?: ModelCatalog,
  availability?: AgentAvailability,
  modelNotes: readonly ModelNoteRule[] = [],
): string {
  const scope: Scope = trusted ? "both" : "user";
  const agents = buildAgentsPrompt(cwd, scope, availability);
  const workflows = buildWorkflowsPrompt(cwd, scope);
  const parts = [
    "The following reusable agent profiles are available to the `workflow_create` tool (optional: agent leaves without `profile` run as anonymous ad-hoc agents):",
    agents.prompt,
    "",
    "The following saved workflows can be invoked with `workflow_create({name, params})` when the user asks for a workflow or for delegation. This catalog is a reference, not an invitation: a workflow existing for a task is never by itself a reason to run one.",
    workflows,
  ];
  if (catalog) {
    parts.push(
      "",
      "The following models are available to delegated agents:",
      buildModelsPrompt(catalog, modelNotes),
    );
  }
  if (!trusted) {
    parts.push(
      "",
      "Note: this project is not trusted, so project-local agents and workflows (.pi/agents, .pi/workflows) are hidden and cannot run.",
    );
  }
  return parts.join("\n");
}

/** Cache the rendered appendix until its session context or model set changes. */
export class PromptAppendixCache {
  private key?: string;
  private appendix?: string;

  get(
    cwd: string,
    trusted: boolean,
    catalog: ModelCatalog | undefined,
    availability: () => AgentAvailability,
    modelNotes: readonly ModelNoteRule[] = [],
  ): string {
    const key = JSON.stringify([cwd, trusted, catalog, modelNotes]);
    if (this.key === key && this.appendix !== undefined) return this.appendix;
    this.key = key;
    this.appendix = buildSystemPromptAppendix(
      cwd,
      trusted,
      catalog,
      availability(),
      modelNotes,
    );
    return this.appendix;
  }

  clear(): void {
    this.key = undefined;
    this.appendix = undefined;
  }
}
