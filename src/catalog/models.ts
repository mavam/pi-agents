import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ModelCatalogEntry {
  id: string;
  /** Input price per million tokens. */
  costIn?: number;
  /** Output price per million tokens. */
  costOut?: number;
  /** Context-window size in tokens. */
  ctx?: number;
  /** Whether the model supports reasoning. */
  reasoning?: boolean;
}

/** Models available to delegated agents, grouped by authenticated provider. */
export interface ModelCatalog {
  providers: Array<{
    id: string;
    subscription: boolean;
    models: ModelCatalogEntry[];
  }>;
}

interface ModelRefreshResult {
  readonly aborted: boolean;
  readonly errors: { readonly size: number };
}

/** Start one model refresh, allowing a later event to retry after failure. */
export function createModelRefresher(): (
  registry: Pick<ModelRegistry, "refresh">,
) => void {
  let started = false;
  return (registry) => {
    if (started) return;
    started = true;
    const pending = registry.refresh() as Promise<
      ModelRefreshResult | undefined
    >;
    void pending.then(
      (result) => {
        if (result && (result.aborted || result.errors.size > 0))
          started = false;
      },
      () => {
        started = false;
      },
    );
  };
}

/**
 * Build a synchronous snapshot of the models whose providers are configured.
 * The caller is responsible for starting the registry's asynchronous refresh.
 */
export function buildModelCatalog(registry: ModelRegistry): ModelCatalog {
  const grouped = new Map<
    string,
    { subscription: boolean; models: Map<string, ModelCatalogEntry> }
  >();

  for (const model of registry.getAvailable()) {
    let provider = grouped.get(model.provider);
    if (!provider) {
      provider = {
        subscription: registry.isUsingOAuth(model),
        models: new Map(),
      };
      grouped.set(model.provider, provider);
    }
    provider.models.set(model.id, {
      id: model.id,
      costIn: model.cost.input,
      costOut: model.cost.output,
      ctx: model.contextWindow,
      reasoning: model.reasoning,
    });
  }

  return {
    providers: [...grouped.entries()]
      .map(([id, provider]) => ({
        id,
        subscription: provider.subscription,
        models: [...provider.models.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
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
    provider.models.map((model) => `${provider.id}/${model.id}`),
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
    if (provider?.models.some((model) => model.id === modelId)) {
      return { ok: true, model: `${providerId}/${modelId}` };
    }
    return {
      ok: false,
      message: unknownModelMessage(ref, available),
    };
  }

  for (const provider of catalog.providers) {
    if (provider.models.some((model) => model.id === ref)) {
      return { ok: true, model: `${provider.id}/${ref}` };
    }
  }
  return {
    ok: false,
    message: unknownModelMessage(ref, available),
  };
}
