/**
 * The parent's system prompt section: one line of guidance, the usable
 * profiles, and the user's scoped models. The tools describe themselves.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { discoverProfiles, type Profile } from "../catalog/profiles.js";
import type { SkillSource } from "../catalog/skills.js";
import { profileProblem } from "./spawn.js";

const GUIDANCE =
  "Delegate work to agents with the agent_* tools when the user asks for it.";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Profiles that can spawn agents, and why the others cannot. */
export async function profileCatalog(
  cwd: string,
  trusted: boolean,
  models: readonly Model<Api>[],
  skills: SkillSource,
): Promise<{ profiles: Profile[]; issues: string[] }> {
  const { profiles, diagnostics } = discoverProfiles(cwd, trusted);
  const usable: Profile[] = [];
  const issues = diagnostics.map(
    (diagnostic) => `${diagnostic.filePath}: ${oneLine(diagnostic.message)}`,
  );
  for (const profile of profiles) {
    const problem = await profileProblem(profile, cwd, trusted, models, skills);
    if (problem) issues.push(`profile ${profile.name}: ${problem}`);
    else usable.push(profile);
  }
  return { profiles: usable, issues };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** An XML element with the defined attributes and optional text. */
function element(
  name: string,
  attributes: Record<string, string | undefined>,
  text?: string,
): string {
  const attrs = Object.entries(attributes)
    .flatMap(([key, value]) =>
      value === undefined ? [] : [` ${key}="${escapeXml(value)}"`],
    )
    .join("");
  return text === undefined
    ? `  <${name}${attrs}/>`
    : `  <${name}${attrs}>${escapeXml(text)}</${name}>`;
}

/** One element per usable profile, its description as text. */
function buildProfilesPrompt(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return "";
  return [
    "<agent_profiles>",
    ...profiles.map((profile) =>
      element(
        "profile",
        {
          name: profile.name,
          model: profile.model,
          thinking: profile.thinking,
          tools: profile.tools?.join(","),
          skills: profile.skills?.join(","),
        },
        oneLine(profile.description),
      ),
    ),
    "</agent_profiles>",
  ].join("\n");
}

/** A model the user scoped, with the thinking level the scope pins. */
export interface ScopedModelEntry {
  model: Model<Api>;
  thinkingLevel?: string;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/** The models the user scoped with `--models` or `/scoped-models`, with
 * their catalog details, so the parent knows which names are models. */
function buildModelsPrompt(models: readonly ScopedModelEntry[]): string {
  if (models.length === 0) return "";
  return [
    '<agent_models note="cost in USD per million input/output tokens">',
    ...models.map(({ model, thinkingLevel }) =>
      element("model", {
        id: `${model.provider}/${model.id}`,
        name: model.name,
        context: model.contextWindow
          ? formatContext(model.contextWindow)
          : undefined,
        cost: model.cost
          ? `${model.cost.input}/${model.cost.output}`
          : undefined,
        thinking: thinkingLevel,
      }),
    ),
    "</agent_models>",
  ].join("\n");
}

export function buildSystemPromptAppendix(
  profiles: readonly Profile[],
  scopedModels: readonly ScopedModelEntry[] = [],
): string {
  return [
    GUIDANCE,
    buildProfilesPrompt(profiles),
    buildModelsPrompt(scopedModels),
  ]
    .filter(Boolean)
    .join("\n");
}
