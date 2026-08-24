import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAgents } from "../../src/catalog/agents.js";
import type { ModelNoteRule } from "../../src/catalog/config.js";
import type { ModelCatalog } from "../../src/catalog/models.js";
import {
  buildModelsPrompt,
  buildSystemPromptAppendix,
  MODELS_PROMPT_BUDGET,
  PromptAppendixCache,
} from "../../src/presentation/prompt.js";
import {
  CatalogCache,
  createProfileAvailability,
  resolveInvocation,
} from "../../src/run/invocation.js";

function modelNote(
  pattern: string,
  note: string,
  scope: "user" | "project" = "user",
): ModelNoteRule {
  return {
    pattern,
    note,
    scope,
    specificity: pattern.split("*")[0]?.length ?? pattern.length,
    order: 0,
  };
}

describe("buildModelsPrompt", () => {
  test("renders providers, authentication, and models", () => {
    const catalog: ModelCatalog = {
      providers: [
        {
          id: "openai-codex",
          subscription: true,
          models: [
            { id: "gpt-5.3-codex-spark", costOut: 1 },
            { id: "gpt-5.6-terra", costOut: 5 },
          ],
        },
        {
          id: "anthropic",
          subscription: false,
          models: [{ id: "claude-opus-4-6", costOut: 12 }],
        },
      ],
    };

    const prompt = buildModelsPrompt(catalog);
    expect(prompt).toContain("<models note=");
    expect(prompt).toContain(
      '<provider id="openai-codex" auth="subscription">gpt-5.3-codex-spark ($), gpt-5.6-terra ($$)</provider>',
    );
    expect(prompt).toContain(
      '<provider id="anthropic" auth="api-key">claude-opus-4-6 ($$$)</provider>',
    );
  });

  test("adds fit notes and only annotates context deviations", () => {
    const catalog: ModelCatalog = {
      providers: [
        {
          id: "anthropic",
          subscription: true,
          models: [
            {
              id: "claude-sonnet-a",
              costOut: 3,
              ctx: 128_000,
            },
            {
              id: "claude-sonnet-b",
              costOut: 3,
              ctx: 128_000,
            },
            {
              id: "claude-small",
              costOut: 1,
              ctx: 32_000,
            },
          ],
        },
      ],
    };
    const prompt = buildModelsPrompt(catalog, [
      modelNote("anthropic/claude-small", "fast extraction"),
    ]);
    expect(prompt).toContain("claude-sonnet-a ($$)");
    expect(prompt).not.toContain("claude-sonnet-a ($$, 128k ctx");
    expect(prompt).toContain("claude-small ($, 32k ctx — fast extraction)");
    expect(prompt).toContain("price tiers (cheap..premium), not quality");
    expect(prompt).toContain("subscription tiers indicate quota burn");
  });

  test("keeps the full id list within budget by degrading annotations in order", () => {
    const models = Array.from({ length: 50 }, (_, index) => ({
      id: `model-${String(index).padStart(2, "0")}`,
      costOut: index % 3 === 0 ? 1 : index % 3 === 1 ? 5 : 12,
      ctx: index === 49 ? 32_000 : 128_000,
    }));
    const catalog: ModelCatalog = {
      providers: [{ id: "provider", subscription: false, models }],
    };
    const notes = models.map((model) =>
      modelNote(
        `provider/${model.id}`,
        `fit-${model.id}-${"guidance".repeat(30)}`,
      ),
    );
    const prompt = buildModelsPrompt(catalog, notes);
    expect(prompt.length).toBeLessThanOrEqual(MODELS_PROMPT_BUDGET);
    for (const model of models) expect(prompt).toContain(model.id);
    expect(prompt).not.toContain("fit-model");
    expect(prompt).toContain("model-49 ($$, 32k ctx)");
  });

  test("escapes provider attributes and model text", () => {
    const prompt = buildModelsPrompt({
      providers: [
        {
          id: "provider<&\"'",
          subscription: false,
          models: [{ id: "model<&>" }],
        },
      ],
    });
    expect(prompt).toContain('id="provider&lt;&amp;&quot;&apos;"');
    expect(prompt).toContain(">model&lt;&amp;&gt;</provider>");
  });

  test("renders a none element for an empty catalog", () => {
    expect(buildModelsPrompt({ providers: [] })).toContain(
      "<none>No available models were discovered.</none>",
    );
  });
});

describe("buildSystemPromptAppendix", () => {
  test("appends models when a catalog is supplied", () => {
    const appendix = buildSystemPromptAppendix(process.cwd(), true, {
      providers: [
        {
          id: "openai-codex",
          subscription: true,
          models: [{ id: "gpt-5.6-terra" }],
        },
      ],
    });
    expect(appendix).toContain("models are available to delegated agents");
    expect(appendix).toContain("without `profile`");
    expect(appendix).toContain("<models note=");
  });

  test("keeps the models section optional", () => {
    expect(buildSystemPromptAppendix(process.cwd())).not.toContain(
      "<models note=",
    );
  });

  test("uses runtime invocation rules to classify unavailable profiles", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-agents-prompt-"));
    try {
      const directory = path.join(cwd, ".pi", "agents");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "valid.md"),
        "---\nname: valid\ndescription: valid profile\n---\nRun.\n",
      );
      writeFileSync(
        path.join(directory, "recursive.md"),
        "---\nname: recursive\ndescription: cannot run\ntools: [workflow_create]\n---\nRun.\n",
      );

      const modelCatalog: ModelCatalog = {
        providers: [
          {
            id: "openai-codex",
            subscription: true,
            models: [{ id: "gpt-5.6-terra" }],
          },
        ],
      };
      const context = {
        cwd,
        scope: "both" as const,
        trusted: true,
        catalogs: new CatalogCache(),
      };
      const availability = createProfileAvailability(context);
      const appendix = buildSystemPromptAppendix(
        cwd,
        true,
        modelCatalog,
        availability,
      );
      expect(appendix).toContain('<agent name="valid"');
      expect(appendix).toContain("<unavailable");
      expect(appendix).toContain('<agent name="recursive"');
      expect(appendix).toContain(
        "delegated agents cannot use orchestration tools",
      );

      const recursive = discoverAgents(cwd, "both").agents.find(
        (profile) => profile.name === "recursive",
      );
      if (!recursive) throw new Error("missing recursive profile");
      const direct = resolveInvocation({ profile: recursive.name }, context);
      if (direct.ok) throw new Error("expected recursive profile to fail");
      expect(availability(recursive)).toBe(direct.problems.join("; "));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("PromptAppendixCache", () => {
  test("renders once per session context and invalidates explicitly", () => {
    const cache = new PromptAppendixCache();
    const catalog: ModelCatalog = { providers: [] };
    let availabilityBuilds = 0;
    const availability = () => {
      availabilityBuilds += 1;
      return () => undefined;
    };

    const first = cache.get(process.cwd(), true, catalog, availability);
    const second = cache.get(process.cwd(), true, catalog, availability);
    expect(second).toBe(first);
    expect(availabilityBuilds).toBe(1);

    cache.clear();
    cache.get(process.cwd(), true, catalog, availability);
    expect(availabilityBuilds).toBe(2);

    const priced: ModelCatalog = {
      providers: [
        {
          id: "test",
          subscription: false,
          models: [{ id: "model", costOut: 1 }],
        },
      ],
    };
    cache.get(process.cwd(), true, priced, availability);
    expect(availabilityBuilds).toBe(3);

    cache.get(
      process.cwd(),
      true,
      {
        providers: [
          {
            id: "test",
            subscription: false,
            models: [{ id: "model", costOut: 12 }],
          },
        ],
      },
      availability,
    );
    expect(availabilityBuilds).toBe(4);

    const notes = [modelNote("test/model", "mechanical work")];
    const noted = cache.get(process.cwd(), true, priced, availability, notes);
    expect(noted).toContain("mechanical work");
    expect(availabilityBuilds).toBe(5);
    cache.get(process.cwd(), true, priced, availability, notes);
    expect(availabilityBuilds).toBe(5);
  });
});
