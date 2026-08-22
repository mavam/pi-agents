import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCatalog } from "../../src/catalog/models.js";
import {
  buildModelsPrompt,
  buildSystemPromptAppendix,
} from "../../src/presentation/prompt.js";

describe("buildModelsPrompt", () => {
  test("renders providers, authentication, and models", () => {
    const catalog: ModelCatalog = {
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
      ],
    };

    const prompt = buildModelsPrompt(catalog);
    expect(prompt).toContain("<models note=");
    expect(prompt).toContain(
      '<provider id="openai-codex" auth="subscription">gpt-5.3-codex-spark, gpt-5.6-terra</provider>',
    );
    expect(prompt).toContain(
      '<provider id="anthropic" auth="api-key">claude-opus-4-6</provider>',
    );
  });

  test("escapes provider attributes and model text", () => {
    const prompt = buildModelsPrompt({
      providers: [
        {
          id: "provider<&\"'",
          subscription: false,
          modelIds: ["model<&>"],
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
          modelIds: ["gpt-5.6-terra"],
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

      const appendix = buildSystemPromptAppendix(cwd, true, {
        providers: [
          {
            id: "openai-codex",
            subscription: true,
            modelIds: ["gpt-5.6-terra"],
          },
        ],
      });
      expect(appendix).toContain('<agent name="valid"');
      expect(appendix).toContain("<unavailable");
      expect(appendix).toContain('<agent name="recursive"');
      expect(appendix).toContain(
        "delegated agents cannot use orchestration tools",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
