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
  models: Array<{ provider: string; id: string }>,
  oauthProviders: string[] = [],
): ModelRegistry {
  return {
    getAvailable: () => models as Model<Api>[],
    getAll: () => {
      throw new Error("buildModelCatalog must not read unavailable models");
    },
    isUsingOAuth: (model: Model<Api>) =>
      oauthProviders.includes(model.provider),
  } as unknown as ModelRegistry;
}

describe("createModelRefresher", () => {
  test("retries after failure and stops after success", async () => {
    let calls = 0;
    const refresh = createModelRefresher();
    const registry = {
      refresh: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("temporary failure"))
          : Promise.resolve();
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
          modelIds: ["gpt-5.3-codex-spark", "gpt-5.6-terra"],
        },
        {
          id: "anthropic",
          subscription: false,
          modelIds: ["claude-opus-4-6"],
        },
        {
          id: "openai",
          subscription: false,
          modelIds: ["alpha", "zeta"],
        },
      ],
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
        modelIds: ["gpt-shared", "gpt-terra"],
      },
      {
        id: "openai",
        subscription: false,
        modelIds: ["gpt-shared", "gpt-api"],
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
