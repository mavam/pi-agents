import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelPattern } from "../../src/catalog/models.js";

const models = [
  ["anthropic", "claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
  ["anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["openai-codex", "gpt-6-sol", "GPT-6 Sol"],
  ["openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol"],
  ["openrouter", "gpt-6-sol", "GPT-6 Sol"],
].map(
  ([provider, id, name]) => ({ provider, id, name }) as unknown as Model<Api>,
);

describe("resolveModelPattern", () => {
  test("partial patterns pick the newest alias", () => {
    expect(resolveModelPattern("sonnet", models)).toEqual({
      ok: true,
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect(resolveModelPattern("sol", models)).toMatchObject({
      modelId: "gpt-6.1-sol",
    });
  });

  test("exact IDs win, including older versions", () => {
    expect(resolveModelPattern("claude-sonnet-4-6", models)).toMatchObject({
      modelId: "claude-sonnet-4-6",
    });
    expect(resolveModelPattern("openrouter/gpt-6-sol", models)).toMatchObject({
      provider: "openrouter",
      modelId: "gpt-6-sol",
    });
  });

  test("unknown patterns point to pi --list-models", () => {
    const resolution = resolveModelPattern("llama", models);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok)
      expect(resolution.message).toContain("pi --list-models");
  });
});
