/**
 * Resolve a spawn request from the parent into a `SpawnSpec`: profile,
 * model, thinking level, tools, skills, and working directory. Settings
 * resolve as explicit arguments, then the profile, then the parent session.
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
  type Scope,
} from "../catalog/profiles.js";
import { loadSkills } from "../catalog/skills.js";

export interface SpawnRequest {
  task: string;
  name?: string;
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
  delegate?: boolean;
}

export function scopeOf(ctx: ExtensionContext): Scope {
  const trusted =
    typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  return trusted ? "both" : "user";
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
  scope: Scope,
): Profile | undefined {
  if (name === undefined) return undefined;
  const { profiles } = discoverProfiles(cwd, scope);
  const profile = findProfile(profiles, name);
  if (!profile) {
    const available = profiles.map((entry) => entry.name).join(", ") || "none";
    throw new AgentError(
      `Unknown profile "${name}". Available profiles: ${available}`,
    );
  }
  return profile;
}

/** Profile instructions plus the profile's skills, inlined. */
function profileInstructions(
  profile: Profile | undefined,
  cwd: string,
  scope: Scope,
): { instructions?: string; ambientSkills: boolean } {
  if (!profile) return { ambientSkills: true };
  const parts = [profile.instructions];
  if (profile.skills !== undefined) {
    const { prompt, missing } = loadSkills(profile.skills, cwd, scope);
    if (missing.length > 0)
      throw new AgentError(
        `Profile ${profile.name} requests unavailable skills: ${missing.join(", ")}`,
      );
    parts.push(prompt);
  }
  const instructions = parts.filter((part) => part.trim()).join("\n\n");
  return {
    ...(instructions ? { instructions } : {}),
    ambientSkills: profile.skills === undefined,
  };
}

/**
 * Why a profile cannot spawn agents, if it cannot: an unknown model or a
 * skill that does not resolve.
 */
export function profileProblem(
  profile: Profile,
  cwd: string,
  scope: Scope,
  models: readonly Model<Api>[],
): string | undefined {
  if (profile.model && !resolveModelPattern(profile.model, models).ok)
    return `no available model matches ${profile.model}`;
  if (profile.skills && profile.skills.length > 0) {
    const { missing } = loadSkills(profile.skills, cwd, scope);
    if (missing.length > 0) return `unavailable skills: ${missing.join(", ")}`;
  }
  return undefined;
}

/**
 * Resolve a spawn. `defaults` replace the parent session's working
 * directory and model, for helpers that inherit their agent's.
 */
export function resolveSpawn(
  request: SpawnRequest,
  ctx: ExtensionContext,
  parentThinking: string | undefined,
  defaults: { cwd?: string; model?: ModelRef } = {},
): SpawnSpec {
  const scope = scopeOf(ctx);
  const cwd = resolveCwd(defaults.cwd ?? ctx.cwd, request.cwd);
  const profile = resolveProfile(request.profile, cwd, scope);
  const model = resolveModel(
    request.model ?? profile?.model,
    ctx,
    defaults.model,
  );
  const thinking = request.thinking ?? profile?.thinking ?? parentThinking;
  if (thinking !== undefined && !isThinkingLevel(thinking))
    throw new AgentError(`Invalid thinking level: ${thinking}`);
  const tools = request.tools ?? profile?.tools;
  const { instructions, ambientSkills } = profileInstructions(
    profile,
    cwd,
    scope,
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
export function resolveHelper(
  request: HelperRequest,
  ctx: ExtensionContext,
  defaults: HelperDefaults,
): SpawnSpec {
  const { delegate: _, ...spec } = resolveSpawn(
    {
      task: request.task,
      ...(request.profile ? { profile: request.profile } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
    },
    ctx,
    defaults.thinking,
    { cwd: defaults.cwd, ...(defaults.model ? { model: defaults.model } : {}) },
  );
  return spec;
}
