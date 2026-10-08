import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resultContent } from "../../src/pi/messages.js";
import {
  buildSystemPromptAppendix,
  profileCatalog,
} from "../../src/pi/prompt.js";
import { FitLines, formatCall, formatPairs } from "../../src/pi/tools.js";

describe("system prompt appendix", () => {
  test("lists guidance and usable profiles", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-project-"),
    );
    fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "scout.md"),
      "---\nname: scout\ndescription: Finds code\nthinking: low\n---\nBe fast.\n",
    );
    const models = [
      { provider: "openai", id: "gpt", name: "GPT" },
    ] as unknown as Parameters<typeof profileCatalog>[2];
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "broken.md"),
      "---\nname: broken\ndescription: Broken\nskills: [missing]\n---\n",
    );
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "offline.md"),
      "---\nname: offline\ndescription: Offline\nmodel: nope/x\n---\n",
    );
    const { profiles, issues } = profileCatalog(project, "both", models);
    expect(profiles.map((profile) => profile.name)).toEqual(["scout"]);
    expect(issues).toEqual([
      "profile broken: unavailable skills: missing (unknown)",
      "profile offline: no available model matches nope/x",
    ]);
    const appendix = buildSystemPromptAppendix(profiles);
    expect(appendix).toBe(
      [
        "Delegate work to agents with the agent_* tools, but only when the user asks for it.",
        "<agent_profiles>",
        "- scout: Finds code (thinking low)",
        "</agent_profiles>",
      ].join("\n"),
    );
    expect(buildSystemPromptAppendix([])).toBe(
      "Delegate work to agents with the agent_* tools, but only when the user asks for it.",
    );
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

describe("tool calls", () => {
  test("explicit arguments render as key=value pairs", () => {
    expect(
      formatPairs({
        profile: "explorer",
        model: "anthropic/claude-haiku-4-5",
        tools: ["read", "grep"],
        cwd: "src dir",
        wait: undefined,
      }),
    ).toBe(
      'profile=explorer model=anthropic/claude-haiku-4-5 tools=[read,grep] cwd="src dir"',
    );
  });

  test("calls show a title, a pairs line, and the body", () => {
    const plain = (_color: string, text: string) => text;
    expect(
      formatCall(
        "spawn",
        { title: "lister", pairs: { thinking: "low" }, body: "List\nfiles" },
        false,
        plain,
      ),
    ).toBe("✦ spawn lister\n  thinking=low\n  List files");
    expect(formatCall("stop", { title: "lister" }, false, plain)).toBe(
      "✦ stop lister",
    );
  });
});

describe("call rendering", () => {
  test("collapsed lines end in an ellipsis instead of wrapping", () => {
    const text =
      "✦ spawn lister\n  List every file in a very long directory name";
    const plain = new FitLines(text, false)
      .render(20)
      .map((line) => stripVTControlCharacters(line));
    expect(plain).toEqual(["✦ spawn lister", "  List every file i…"]);
    expect(new FitLines(text, true).render(20).length).toBeGreaterThan(2);
  });
});
