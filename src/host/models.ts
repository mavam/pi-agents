/**
 * Model access for agents. Agents share the parent session's model runtime,
 * so logins and providers that extensions registered work for them too.
 */

import type { Models } from "@earendil-works/pi-ai";
import {
  type ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

function isModels(value: unknown): value is Models {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getModel === "function" &&
    typeof candidate.getProvider === "function" &&
    typeof candidate.getProviders === "function"
  );
}

/**
 * The parent's runtime behind `ModelRegistry`. Pi 1.1 keeps it in a private
 * field; without it, a fresh runtime still reads Pi's stored credentials but
 * misses providers that extensions registered.
 */
export async function resolveModels(registry: ModelRegistry): Promise<Models> {
  const runtime = (registry as unknown as { runtime?: unknown }).runtime;
  if (isModels(runtime)) return runtime;
  return ModelRuntime.create();
}
