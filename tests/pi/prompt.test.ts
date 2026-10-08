import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resultContent } from "../../src/pi/messages.js";
import {
  buildModelsPrompt,
  buildSystemPromptAppendix,
} from "../../src/pi/prompt.js";

describe("system prompt appendix", () => {
  test("lists guidance, profiles, and models", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-project-"),
    );
    fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "scout.md"),
      "---\nname: scout\ndescription: Finds code\nthinking: low\n---\nBe fast.\n",
    );
    const appendix = buildSystemPromptAppendix(project, "both", {
      providers: [
        {
          id: "openai",
          subscription: true,
          models: [{ id: "gpt", costOut: 1 }],
        },
      ],
    });
    expect(appendix).toContain("agent_spawn");
    expect(appendix).toContain(
      '<profile name="scout" source="project" thinking="low">Finds code</profile>',
    );
    expect(appendix).toContain(
      '<provider id="openai" auth="subscription">gpt ($)</provider>',
    );
    expect(buildSystemPromptAppendix(project, "user", undefined)).toContain(
      "not trusted",
    );
  });

  test("model lists drop annotations to fit the budget", () => {
    const models = Array.from({ length: 300 }, (_, index) => ({
      id: `model-${index}`,
      costOut: 20,
    }));
    const prompt = buildModelsPrompt({
      providers: [{ id: "p", subscription: false, models }],
    });
    expect(prompt).toContain("model-299");
    expect(prompt).not.toContain("$$$");
  });
});

describe("result messages", () => {
  test("answered and failed results read clearly", () => {
    const base = { version: 1 as const, agentId: "1", name: "reviewer" };
    expect(
      resultContent({ ...base, kind: "answered", body: "All good." }, true),
    ).toBe(
      'Agent "reviewer" finished. Its final message:\n\nAll good.\n\nContinue your task using this result.',
    );
    expect(
      resultContent({ ...base, kind: "failed", body: "rate limited" }, false),
    ).toBe('Agent "reviewer" failed: rate limited');
  });
});
