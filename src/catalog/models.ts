import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Models available to delegated agents, grouped by authenticated provider. */
export interface ModelCatalog {
  providers: Array<{
    id: string;
    subscription: boolean;
    modelIds: string[];
  }>;
}

/** Start one model refresh, allowing a later event to retry after failure. */
export function createModelRefresher(): (
  registry: Pick<ModelRegistry, "refresh">,
) => void {
  let started = false;
  return (registry) => {
    if (started) return;
    started = true;
    try {
      void registry.refresh().then(
        (result) => {
          if (result?.aborted || (result?.errors?.size ?? 0) > 0) {
            started = false;
          }
        },
        () => {
          started = false;
        },
      );
    } catch {
      started = false;
    }
  };
}

/**
 * Build a synchronous snapshot of the models whose providers are configured.
 * The caller is responsible for starting the registry's asynchronous refresh.
 */
export function buildModelCatalog(registry: ModelRegistry): ModelCatalog {
  const grouped = new Map<
    string,
    { subscription: boolean; modelIds: Set<string> }
  >();

  for (const model of registry.getAvailable()) {
    let provider = grouped.get(model.provider);
    if (!provider) {
      provider = {
        subscription: registry.isUsingOAuth(model),
        modelIds: new Set(),
      };
      grouped.set(model.provider, provider);
    }
    provider.modelIds.add(model.id);
  }

  return {
    providers: [...grouped.entries()]
      .map(([id, provider]) => ({
        id,
        subscription: provider.subscription,
        modelIds: [...provider.modelIds].sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort(
        (left, right) =>
          Number(right.subscription) - Number(left.subscription) ||
          left.id.localeCompare(right.id),
      ),
  };
}

export type ModelReferenceResolution =
  | { ok: true; model: string }
  | { ok: false; message: string };

function availableModels(catalog: ModelCatalog): string[] {
  return catalog.providers.flatMap((provider) =>
    provider.modelIds.map((id) => `${provider.id}/${id}`),
  );
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

/** Rank a possible model without depending on Pi's internal model resolver. */
function suggestionScore(ref: string, candidate: string): number {
  const query = ref.toLowerCase();
  const canonical = candidate.toLowerCase();
  const modelId = canonical.slice(canonical.indexOf("/") + 1);
  if (canonical.startsWith(query)) return 100;
  if (modelId.startsWith(query)) return 90;
  if (canonical.includes(query)) return 80;
  if (modelId.includes(query)) return 70;

  const slash = query.indexOf("/");
  if (slash >= 0) {
    const provider = query.slice(0, slash);
    const candidateProvider = canonical.slice(0, canonical.indexOf("/"));
    if (provider === candidateProvider) {
      const requestedId = query.slice(slash + 1);
      return 50 + commonPrefixLength(requestedId, modelId);
    }
  }

  const prefix = commonPrefixLength(query, modelId);
  return prefix >= 3 ? prefix : 0;
}

function suggestions(ref: string, available: string[]): string[] {
  return available
    .map((model, index) => ({
      model,
      index,
      score: suggestionScore(ref, model),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(({ model }) => model);
}

function unknownModelMessage(ref: string, available: string[]): string {
  const fullList = available.join(", ") || "none";
  const nearby = suggestions(ref, available);
  if (nearby.length > 0) {
    return `unknown model '${ref}' — suggestions: ${nearby.join(", ")}; available: ${fullList}`;
  }
  return `unknown model '${ref}' — available: ${fullList}`;
}

/** Resolve a bare or provider-qualified model reference against the catalog. */
export function resolveModelReference(
  ref: string,
  catalog: ModelCatalog,
): ModelReferenceResolution {
  const available = availableModels(catalog);
  const slash = ref.indexOf("/");
  if (slash >= 0) {
    const providerId = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const provider = catalog.providers.find(({ id }) => id === providerId);
    if (provider?.modelIds.includes(modelId)) {
      return { ok: true, model: `${providerId}/${modelId}` };
    }
    return {
      ok: false,
      message: unknownModelMessage(ref, available),
    };
  }

  for (const provider of catalog.providers) {
    if (provider.modelIds.includes(ref)) {
      return { ok: true, model: `${provider.id}/${ref}` };
    }
  }
  return {
    ok: false,
    message: unknownModelMessage(ref, available),
  };
}
