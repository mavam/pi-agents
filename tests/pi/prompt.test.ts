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
    expect(appendix).toBe(
      [
        "Delegate work to agents with the agent_* tools, but only when the user asks for it.",
        "<agent_profiles>",
        "- scout: Finds code (thinking low)",
        "</agent_profiles>",
        '<agent_models note="$ to $$$: price tier">',
        "openai: gpt ($)",
        "</agent_models>",
      ].join("\n"),
    );
    expect(buildSystemPromptAppendix(project, "user", undefined)).toBe(
      "Delegate work to agents with the agent_* tools, but only when the user asks for it.",
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
      resultContent({ ...base, kind: "answered", body: "All good." }),
    ).toBe("Agent reviewer answered:\n\nAll good.");
    expect(
      resultContent({ ...base, kind: "failed", body: "rate limited" }),
    ).toBe("Agent reviewer failed: rate limited");
  });
});
