/**
 * The parent's system prompt section: one line of guidance, the profiles,
 * and the models agents can use. The tools describe themselves.
 */

import { type ModelNoteRule, resolveModelNote } from "../catalog/config.js";
import type { ModelCatalog, ModelCatalogEntry } from "../catalog/models.js";
import {
  discoverProfiles,
  type Profile,
  type Scope,
} from "../catalog/profiles.js";
import { profileProblem } from "./spawn.js";

const GUIDANCE =
  "Delegate work to agents with the agent_* tools, but only when the user asks for it.";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Profiles that can spawn agents, and why the others cannot. */
export function profileCatalog(
  cwd: string,
  scope: Scope,
  catalog: ModelCatalog | undefined,
): { profiles: Profile[]; issues: string[] } {
  const { profiles, diagnostics } = discoverProfiles(cwd, scope);
  const usable: Profile[] = [];
  const issues = diagnostics.map(
    (diagnostic) => `${diagnostic.filePath}: ${oneLine(diagnostic.message)}`,
  );
  for (const profile of profiles) {
    const problem = profileProblem(profile, cwd, scope, catalog);
    if (problem) issues.push(`profile ${profile.name}: ${problem}`);
    else usable.push(profile);
  }
  return { profiles: usable, issues };
}

/** `- name: description (model, thinking, tools)` per usable profile. */
function buildProfilesPrompt(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return "";
  const lines = profiles.map((profile) => {
    const settings = [
      profile.model,
      profile.thinking && `thinking ${profile.thinking}`,
      profile.tools && `tools ${profile.tools.join(",")}`,
    ].filter(Boolean);
    const suffix = settings.length > 0 ? ` (${settings.join(", ")})` : "";
    return `- ${profile.name}: ${oneLine(profile.description)}${suffix}`;
  });
  return ["<agent_profiles>", ...lines, "</agent_profiles>"].join("\n");
}

const MODELS_PROMPT_BUDGET = 4_096;

function costTier(costOut: number | undefined): string | undefined {
  if (costOut === undefined) return undefined;
  if (costOut < 2) return "$";
  if (costOut < 10) return "$$";
  return "$$$";
}

interface ModelPromptOptions {
  notes: boolean;
  tiers: boolean;
}

function renderModel(
  providerId: string,
  model: ModelCatalogEntry,
  notes: readonly ModelNoteRule[],
  options: ModelPromptOptions,
): string {
  const tier = options.tiers ? costTier(model.costOut) : undefined;
  const note = options.notes
    ? resolveModelNote(notes, `${providerId}/${model.id}`)
    : undefined;
  const annotation = [tier, note].filter(Boolean).join(", ");
  return annotation ? `${model.id} (${annotation})` : model.id;
}

function renderModelsPrompt(
  catalog: ModelCatalog,
  notes: readonly ModelNoteRule[],
  options: ModelPromptOptions,
): string {
  const lines = catalog.providers.map(
    (provider) =>
      `${provider.id}: ${provider.models
        .map((model) => renderModel(provider.id, model, notes, options))
        .join(", ")}`,
  );
  const note = options.tiers ? ' note="$ to $$$: price tier"' : "";
  return [`<agent_models${note}>`, ...lines, "</agent_models>"].join("\n");
}

/** The model catalog, dropping annotations until it fits the budget. The ID
 * list is never truncated. */
export function buildModelsPrompt(
  catalog: ModelCatalog,
  notes: readonly ModelNoteRule[] = [],
): string {
  if (catalog.providers.length === 0) return "";
  const attempts: ModelPromptOptions[] = [
    { notes: true, tiers: true },
    { notes: false, tiers: true },
    { notes: false, tiers: false },
  ];
  let prompt = "";
  for (const options of attempts) {
    prompt = renderModelsPrompt(catalog, notes, options);
    if (prompt.length <= MODELS_PROMPT_BUDGET) return prompt;
  }
  return prompt;
}

export function buildSystemPromptAppendix(
  profiles: readonly Profile[],
  catalog: ModelCatalog | undefined,
  notes: readonly ModelNoteRule[] = [],
): string {
  return [
    GUIDANCE,
    buildProfilesPrompt(profiles),
    catalog ? buildModelsPrompt(catalog, notes) : "",
  ]
    .filter(Boolean)
    .join("\n");
}
