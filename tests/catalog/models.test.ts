import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  buildModelCatalog,
  createModelRefresher,
  type ModelCatalog,
  resolveModelReference,
} from "../../src/catalog/models.js";

function fakeRegistry(
  models: Array<{
    provider: string;
    id: string;
    cost?: {
      input: number;
      output: number;
      tiers?: Array<{
        inputTokensAbove: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }>;
    };
    contextWindow?: number;
    reasoning?: boolean;
  }>,
  oauthProviders: string[] = [],
): ModelRegistry {
  const available = models.map((model) => ({
    ...model,
    cost: {
      input: model.cost?.input ?? 1,
      output: model.cost?.output ?? 2,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: model.cost?.tiers,
    },
    contextWindow: model.contextWindow ?? 128_000,
    reasoning: model.reasoning ?? true,
  })) as Model<Api>[];
  return {
    getAvailable: () => available,
    getAll: () => {
      throw new Error("buildModelCatalog must not read unavailable models");
    },
    isUsingOAuth: (model: Model<Api>) =>
      oauthProviders.includes(model.provider),
  } as unknown as ModelRegistry;
}

describe("createModelRefresher", () => {
  test("retries after reported provider errors and stops after success", async () => {
    let calls = 0;
    const refresh = createModelRefresher();
    const registry: Pick<ModelRegistry, "refresh"> = {
      refresh: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                aborted: false,
                errors: new Map([
                  ["test-provider", new Error("temporary failure")],
                ]),
              }
            : { aborted: false, errors: new Map() },
        );
      },
    };

    refresh(registry);
    refresh(registry);
    expect(calls).toBe(1);

    await Promise.resolve();
    refresh(registry);
    expect(calls).toBe(2);

    await Promise.resolve();
    refresh(registry);
    expect(calls).toBe(2);
  });

  test("retries after an unexpected refresh rejection", async () => {
    let calls = 0;
    const refresh = createModelRefresher();
    const registry: Pick<ModelRegistry, "refresh"> = {
      refresh: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("temporary failure"))
          : Promise.resolve({ aborted: false, errors: new Map() });
      },
    };

    refresh(registry);
    await Promise.resolve();
    refresh(registry);
    expect(calls).toBe(2);
  });

  test("accepts refreshes without a result", async () => {
    let calls = 0;
    const refresh = createModelRefresher();
    const registry: Pick<ModelRegistry, "refresh"> = {
      refresh: async () => {
        calls += 1;
      },
    };

    refresh(registry);
    await Promise.resolve();
    refresh(registry);
    expect(calls).toBe(1);
  });
});

describe("buildModelCatalog", () => {
  test("groups available models and sorts provider and model ids", () => {
    const catalog = buildModelCatalog(
      fakeRegistry(
        [
          { provider: "openai", id: "zeta" },
          { provider: "openai-codex", id: "gpt-5.6-terra" },
          { provider: "anthropic", id: "claude-opus-4-6" },
          { provider: "openai", id: "alpha" },
          { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
        ],
        ["openai-codex"],
      ),
    );

    expect(catalog).toEqual({
      providers: [
        {
          id: "openai-codex",
          subscription: true,
          models: [
            {
              id: "gpt-5.3-codex-spark",
              costIn: 1,
              costOut: 2,
              ctx: 128_000,
              reasoning: true,
            },
            {
              id: "gpt-5.6-terra",
              costIn: 1,
              costOut: 2,
              ctx: 128_000,
              reasoning: true,
            },
          ],
        },
        {
          id: "anthropic",
          subscription: false,
          models: [
            {
              id: "claude-opus-4-6",
              costIn: 1,
              costOut: 2,
              ctx: 128_000,
              reasoning: true,
            },
          ],
        },
        {
          id: "openai",
          subscription: false,
          models: [
            {
              id: "alpha",
              costIn: 1,
              costOut: 2,
              ctx: 128_000,
              reasoning: true,
            },
            {
              id: "zeta",
              costIn: 1,
              costOut: 2,
              ctx: 128_000,
              reasoning: true,
            },
          ],
        },
      ],
    });
  });

  test("carries base-tier cost and fit metadata", () => {
    const catalog = buildModelCatalog(
      fakeRegistry([
        {
          provider: "test",
          id: "priced",
          cost: {
            input: 3.5,
            output: 12,
            tiers: [
              {
                inputTokensAbove: 200_000,
                input: 7,
                output: 24,
                cacheRead: 0,
                cacheWrite: 0,
              },
            ],
          },
          contextWindow: 32_000,
          reasoning: false,
        },
      ]),
    );
    expect(catalog.providers[0]?.models[0]).toEqual({
      id: "priced",
      costIn: 3.5,
      costOut: 12,
      ctx: 32_000,
      reasoning: false,
    });
  });

  test("uses only available models", () => {
    expect(buildModelCatalog(fakeRegistry([]))).toEqual({ providers: [] });
  });
});

describe("resolveModelReference", () => {
  const catalog: ModelCatalog = {
    providers: [
      {
        id: "openai-codex",
        subscription: true,
        models: [{ id: "gpt-shared" }, { id: "gpt-terra" }],
      },
      {
        id: "openai",
        subscription: false,
        models: [{ id: "gpt-shared" }, { id: "gpt-api" }],
      },
    ],
  };

  test("resolves an exact provider-qualified reference", () => {
    expect(resolveModelReference("openai/gpt-api", catalog)).toEqual({
      ok: true,
      model: "openai/gpt-api",
    });
  });

  test("a bare id picks the first provider in catalog order", () => {
    expect(resolveModelReference("gpt-shared", catalog)).toEqual({
      ok: true,
      model: "openai-codex/gpt-shared",
    });
  });

  test("an unknown reference includes suggestions", () => {
    const result = resolveModelReference("gpt-ter", catalog);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("unknown model 'gpt-ter'");
    expect(result.message).toContain("openai-codex/gpt-terra");
    expect(result.message).toContain("available:");
  });

  test("an unknown qualified reference labels nearby models as suggestions", () => {
    const result = resolveModelReference("openai/gpt-missing", catalog);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(
      "suggestions: openai/gpt-shared, openai/gpt-api",
    );
    expect(result.message).toContain(
      "available: openai-codex/gpt-shared, openai-codex/gpt-terra, openai/gpt-shared, openai/gpt-api",
    );
  });

  test("an empty catalog reports no available models", () => {
    expect(resolveModelReference("anything", { providers: [] })).toEqual({
      ok: false,
      message: "unknown model 'anything' — available: none",
    });
  });
});
