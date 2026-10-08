/**
 * The parent's system prompt appendix: how to delegate, the profile catalog,
 * and the models agents can use.
 */

import { type ModelNoteRule, resolveModelNote } from "../catalog/config.js";
import type { ModelCatalog, ModelCatalogEntry } from "../catalog/models.js";
import { discoverProfiles, type Scope } from "../catalog/profiles.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";

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

export const GUIDANCE = [
  "You can delegate work to agents with the agent_* tools. An agent is a separate, durable pi agent with its own context window. It runs in the background, keeps its conversation after it answers, and survives restarts of this session.",
  "",
  "- Delegate only when the user asks for it, for example to delegate, to run agents in parallel, or to get an independent review. Mentioning agents is not a request to start one.",
  "- Give each agent a self-contained task: it does not see this conversation. Name agents after their role.",
  "- An agent's result is its final message. Results of agents you do not wait for arrive later as messages; do not poll with agent_status.",
  "- Use agent_wait when you need results before continuing, and agent_send to follow up with an agent that already has relevant context.",
  "- Close agents with agent_close once you no longer need them.",
  `- Agents can use these tools: ${AGENT_TOOL_NAMES.join(", ")}. They cannot use MCP servers, extension tools, or other agents.`,
].join("\n");

export function buildProfilesPrompt(cwd: string, scope: Scope): string {
  const { profiles, diagnostics } = discoverProfiles(cwd, scope);
  const lines = ["<agent_profiles>"];
  if (profiles.length === 0) {
    lines.push(
      "  <none>No profiles. Spawn agents without a profile; they inherit this session's model.</none>",
    );
  }
  for (const profile of profiles) {
    const attributes = [
      `name="${escapeXmlAttribute(profile.name)}"`,
      `source="${profile.source}"`,
      profile.model ? `model="${escapeXmlAttribute(profile.model)}"` : "",
      profile.thinking ? `thinking="${profile.thinking}"` : "",
      profile.tools
        ? `tools="${escapeXmlAttribute(profile.tools.join(","))}"`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  <profile ${attributes}>${escapeXmlText(profile.description)}</profile>`,
    );
  }
  for (const diagnostic of diagnostics) {
    lines.push(
      `  <diagnostic path="${escapeXmlAttribute(diagnostic.filePath)}">${escapeXmlText(diagnostic.message)}</diagnostic>`,
    );
  }
  lines.push("</agent_profiles>");
  return lines.join("\n");
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

interface ModelPromptOptions {
  notes: boolean;
  deviations: boolean;
  tiers: boolean;
}

function renderModel(
  providerId: string,
  model: ModelCatalogEntry,
  modes: { ctx?: number },
  notes: readonly ModelNoteRule[],
  options: ModelPromptOptions,
): string {
  const annotations: string[] = [];
  if (options.tiers) {
    const tier = costTier(model.costOut);
    if (tier) annotations.push(tier);
  }
  if (
    options.deviations &&
    model.ctx !== undefined &&
    modes.ctx !== undefined &&
    model.ctx !== modes.ctx
  )
    annotations.push(contextLabel(model.ctx));
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
  options: ModelPromptOptions,
): string {
  const note = [
    "valid values for agent_spawn 'model' (omit to inherit this session's model); when an id exists under several providers, prefer the earlier provider",
    options.tiers
      ? "$..$$$ are price tiers (cheap..premium), not quality; subscription tiers indicate quota burn; prefer $ for mechanical tasks and $$$ for planning and review"
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  const lines = [`<agent_models note="${escapeXmlAttribute(note)}">`];
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
  lines.push("</agent_models>");
  return lines.join("\n");
}

/** The model catalog, dropping annotations until it fits the budget. The ID
 * list is the contract and is never truncated. */
export function buildModelsPrompt(
  catalog: ModelCatalog,
  notes: readonly ModelNoteRule[] = [],
): string {
  const attempts: ModelPromptOptions[] = [
    { notes: true, deviations: true, tiers: true },
    { notes: false, deviations: true, tiers: true },
    { notes: false, deviations: false, tiers: true },
    { notes: false, deviations: false, tiers: false },
  ];
  let prompt = "";
  for (const options of attempts) {
    prompt = renderModelsPrompt(catalog, notes, options);
    if (prompt.length <= MODELS_PROMPT_BUDGET) return prompt;
  }
  return prompt;
}

export function buildSystemPromptAppendix(
  cwd: string,
  scope: Scope,
  catalog: ModelCatalog | undefined,
  notes: readonly ModelNoteRule[] = [],
): string {
  const parts = [
    "<pi_agents>",
    GUIDANCE,
    "</pi_agents>",
    buildProfilesPrompt(cwd, scope),
  ];
  if (catalog) parts.push(buildModelsPrompt(catalog, notes));
  if (scope === "user")
    parts.push(
      "Note: this project is not trusted, so project profiles (.pi/agents) are hidden and agents do not load project context files or skills.",
    );
  return parts.join("\n");
}
