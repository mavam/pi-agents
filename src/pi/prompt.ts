/**
 * The parent's system prompt section: one line of guidance and the usable
 * profiles. The tools describe themselves; model choice stays with Pi's
 * `--model` patterns.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
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
  models: readonly Model<Api>[],
): { profiles: Profile[]; issues: string[] } {
  const { profiles, diagnostics } = discoverProfiles(cwd, scope);
  const usable: Profile[] = [];
  const issues = diagnostics.map(
    (diagnostic) => `${diagnostic.filePath}: ${oneLine(diagnostic.message)}`,
  );
  for (const profile of profiles) {
    const problem = profileProblem(profile, cwd, scope, models);
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

export function buildSystemPromptAppendix(
  profiles: readonly Profile[],
): string {
  return [GUIDANCE, buildProfilesPrompt(profiles)].filter(Boolean).join("\n");
}
