/**
 * Resolve a spawn request from the parent into a `SpawnSpec`: profile,
 * model, thinking level, tools, skills, and working directory. Settings
 * resolve as explicit arguments, then the profile, then the parent session.
 * Skills a model names in a tool call must be ones a model may invoke.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AgentError,
  type HelperDefaults,
  type HelperRequest,
  isThinkingLevel,
  type ModelRef,
  type SpawnSpec,
  type ThinkingLevel,
} from "../agents/types.js";
import { resolveModelPattern } from "../catalog/models.js";
import {
  discoverProfiles,
  findProfile,
  type Profile,
} from "../catalog/profiles.js";
import {
  type Chooser,
  inlineSkills,
  type SkillSource,
} from "../catalog/skills.js";

export interface SpawnRequest {
  task: string;
  name?: string;
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  cwd?: string;
  delegate?: boolean;
}

/** What a spawn draws on besides its request. */
export interface SpawnSources {
  /** The skills of a directory; the session's shared catalog. */
  skills: SkillSource;
  /** Thinking level without one in the request or profile. */
  thinking?: string;
  /** Working directory and model instead of the parent session's, for
   * helpers that inherit their agent's. */
  cwd?: string;
  model?: ModelRef;
}

/** Whether the session trusts its project, which gates project profiles,
 * skills, and context files. */
export function isTrusted(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : true;
}

function resolveModel(
  pattern: string | undefined,
  ctx: ExtensionContext,
  fallback?: ModelRef,
): ModelRef | undefined {
  if (pattern === undefined) {
    if (fallback) return fallback;
    const model = ctx.model;
    return model ? { provider: model.provider, modelId: model.id } : undefined;
  }
  const resolved = resolveModelPattern(
    pattern,
    ctx.modelRegistry.getAvailable(),
  );
  if (!resolved.ok) throw new AgentError(resolved.message);
  return { provider: resolved.provider, modelId: resolved.modelId };
}

function resolveCwd(base: string, requested: string | undefined): string {
  const cwd = path.resolve(base, requested ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new AgentError(`Working directory not found: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new AgentError(`Not a directory: ${cwd}`);
  return cwd;
}

function resolveProfile(
  name: string | undefined,
  cwd: string,
  trusted: boolean,
): Profile | undefined {
  if (name === undefined) return undefined;
  const { profiles } = discoverProfiles(cwd, trusted);
  const profile = findProfile(profiles, name);
  if (!profile) {
    const available = profiles.map((entry) => entry.name).join(", ") || "none";
    throw new AgentError(
      `Unknown profile "${name}". Available profiles: ${available}`,
    );
  }
  return profile;
}

/** Inline the named skills, or say which are missing. */
async function skillsPrompt(
  names: readonly string[],
  chooser: Chooser,
  cwd: string,
  trusted: boolean,
  source: SkillSource,
): Promise<{ prompt: string; missing: string[] }> {
  if (names.length === 0) return { prompt: "", missing: [] };
  return inlineSkills(names, await source(cwd, trusted), chooser);
}

/**
 * The profile body plus the inlined skills. Skills in the request replace
 * the profile's; either list turns off the ambient catalog. The user writes
 * profiles, so only they may name skills that models can't invoke.
 */
async function instructionsOf(
  profile: Profile | undefined,
  requested: string[] | undefined,
  cwd: string,
  trusted: boolean,
  source: SkillSource,
): Promise<{ instructions?: string; ambientSkills: boolean }> {
  const parts = [profile?.instructions ?? ""];
  const names = requested ?? profile?.skills;
  if (names !== undefined) {
    const chooser = requested !== undefined ? "model" : "user";
    const { prompt, missing } = await skillsPrompt(
      names,
      chooser,
      cwd,
      trusted,
      source,
    );
    if (missing.length > 0)
      throw new AgentError(
        chooser === "model"
          ? `Unavailable skills: ${missing.join(", ")}`
          : `Profile ${profile?.name} requests unavailable skills: ${missing.join(", ")}`,
      );
    parts.push(prompt);
  }
  const instructions = parts.filter((part) => part.trim()).join("\n\n");
  return {
    ...(instructions ? { instructions } : {}),
    ambientSkills: names === undefined,
  };
}

/**
 * Why a profile cannot spawn agents, if it cannot: an unknown model or a
 * skill that does not resolve.
 */
export async function profileProblem(
  profile: Profile,
  cwd: string,
  trusted: boolean,
  models: readonly Model<Api>[],
  source: SkillSource,
): Promise<string | undefined> {
  if (profile.model && !resolveModelPattern(profile.model, models).ok)
    return `no available model matches ${profile.model}`;
  try {
    const { missing } = await skillsPrompt(
      profile.skills ?? [],
      "user",
      cwd,
      trusted,
      source,
    );
    if (missing.length > 0) return `unavailable skills: ${missing.join(", ")}`;
  } catch (error) {
    return `skills don't load: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

/** Resolve a spawn. */
export async function resolveSpawn(
  request: SpawnRequest,
  ctx: ExtensionContext,
  sources: SpawnSources,
): Promise<SpawnSpec> {
  const trusted = isTrusted(ctx);
  const cwd = resolveCwd(sources.cwd ?? ctx.cwd, request.cwd);
  const profile = resolveProfile(request.profile, cwd, trusted);
  const model = resolveModel(
    request.model ?? profile?.model,
    ctx,
    sources.model,
  );
  const thinking = request.thinking ?? profile?.thinking ?? sources.thinking;
  if (thinking !== undefined && !isThinkingLevel(thinking))
    throw new AgentError(`Invalid thinking level: ${thinking}`);
  const tools = request.tools ?? profile?.tools;
  const { instructions, ambientSkills } = await instructionsOf(
    profile,
    request.skills,
    cwd,
    trusted,
    sources.skills,
  );
  const delegate = request.delegate ?? profile?.delegate;
  return {
    task: request.task,
    cwd,
    ambientSkills,
    ...(delegate ? { delegate: true } : {}),
    ...(request.name ? { name: request.name } : {}),
    ...(profile ? { profile: profile.name } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * A helper's settings: resolved like the parent's spawns, with its agent's
 * working directory, model, and thinking level as defaults. Helpers never
 * delegate.
 */
export async function resolveHelper(
  request: HelperRequest,
  ctx: ExtensionContext,
  defaults: HelperDefaults,
  skills: SkillSource,
): Promise<SpawnSpec> {
  const { delegate: _, ...spec } = await resolveSpawn(
    {
      task: request.task,
      ...(request.profile ? { profile: request.profile } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.skills ? { skills: request.skills } : {}),
    },
    ctx,
    {
      skills,
      cwd: defaults.cwd,
      ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
    },
  );
  return spec;
}
