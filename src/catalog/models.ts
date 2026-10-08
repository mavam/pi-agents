/**
 * Model patterns, resolved the way `pi --model` resolves them but only among
 * models with configured credentials: an exact `provider/id` or `id` first,
 * otherwise a partial match on ID or name, preferring the newest alias over
 * dated snapshots.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type ModelResolution =
  | { ok: true; provider: string; modelId: string }
  | { ok: false; message: string };

const SNAPSHOT = /-\d{8}$/;

function exact(pattern: string, models: readonly Model<Api>[]) {
  const reference = pattern.toLowerCase();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === reference,
  );
  if (canonical.length === 1) return canonical[0];
  const byId = models.filter((model) => model.id.toLowerCase() === reference);
  return byId.length === 1 ? byId[0] : undefined;
}

function partial(pattern: string, models: readonly Model<Api>[]) {
  const needle = pattern.toLowerCase();
  const matches = models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) ||
      model.name?.toLowerCase().includes(needle),
  );
  const aliases = matches.filter((model) => !SNAPSHOT.test(model.id));
  const pool = aliases.length > 0 ? aliases : matches;
  return [...pool].sort((left, right) => right.id.localeCompare(left.id))[0];
}

/** Resolve a model pattern such as `sonnet`, `gpt-6.1-sol`, or
 * `anthropic/claude-sonnet-5-5` against the available models. */
export function resolveModelPattern(
  pattern: string,
  models: readonly Model<Api>[],
): ModelResolution {
  const trimmed = pattern.trim();
  const model = exact(trimmed, models) ?? partial(trimmed, models);
  if (!model)
    return {
      ok: false,
      message: `No available model matches "${trimmed}". Run pi --list-models to see available models.`,
    };
  return { ok: true, provider: model.provider, modelId: model.id };
}
