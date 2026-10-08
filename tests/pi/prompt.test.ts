import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { shapeLine } from "../../src/agents/topology.js";
import {
  graphContent,
  type NodeDetails,
  resultContent,
} from "../../src/pi/messages.js";
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
        "Delegate work to agents with the agent_* tools when the user asks for it.",
        "<agent_profiles>",
        '  <profile name="scout" thinking="low">Finds code</profile>',
        "</agent_profiles>",
      ].join("\n"),
    );
    expect(
      buildSystemPromptAppendix([], [
        {
          model: {
            provider: "anthropic",
            id: "claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
            contextWindow: 1_000_000,
            cost: { input: 2, output: 10 },
          },
        },
        {
          model: { provider: "openai-codex", id: "gpt-6.1-sol" },
          thinkingLevel: "high",
        },
      ] as never),
    ).toBe(
      [
        "Delegate work to agents with the agent_* tools when the user asks for it.",
        '<agent_models note="cost in USD per million input/output tokens">',
        '  <model id="anthropic/claude-sonnet-5-5" name="Claude Sonnet 5.5" context="1M" cost="2/10"/>',
        '  <model id="openai-codex/gpt-6.1-sol" thinking="high"/>',
        "</agent_models>",
      ].join("\n"),
    );
    expect(buildSystemPromptAppendix([])).toBe(
      "Delegate work to agents with the agent_* tools when the user asks for it.",
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

describe("graph result messages", () => {
  const node = (
    name: string,
    kind: NodeDetails["kind"],
    body: string,
    end: boolean,
  ): NodeDetails => ({ agentId: name, name, kind, body, end, inputs: [] });

  test("one end agent reads as its answer; problems are named", () => {
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "review",
        policy: "allSettled",
        nodes: [
          node("api", "answered", "Two routes.", false),
          node("docs", "failed", "rate limited", false),
          node("merge", "answered", "One overview.", true),
        ],
      }),
    ).toBe(
      [
        "Graph review: merge answered:",
        "",
        "One overview.",
        "",
        "Other agents: docs failed: rate limited.",
      ].join("\n"),
    );
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "chain",
        policy: "allSettled",
        nodes: [
          node("first", "failed", "boom", false),
          node("second", "skipped", "", true),
        ],
      }),
    ).toBe(
      "Graph chain: second was skipped because none of its inputs answered.\n\nOther agents: first failed: boom.",
    );
  });

  test("several end agents read under their own headings", () => {
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "review",
        policy: "failFast",
        nodes: [
          node("api", "answered", "Two routes.", true),
          node("docs", "failed", "rate limited", true),
          node("tests", "stopped", "", true),
        ],
      }),
    ).toBe(
      [
        "Graph review finished: 1 answered, 1 failed, 1 stopped.",
        "",
        "## api (answered)",
        "Two routes.",
        "",
        "## docs (failed)",
        "Error: rate limited",
        "",
        "## tests (stopped)",
      ].join("\n"),
    );
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

  test("graph calls collapse to their shape", () => {
    const plain = (_color: string, text: string) => text;
    const view = {
      title: "review",
      pairs: { failFast: true },
      body: "api (model=sol): Map the API\ntests: Check the tests\nmerge ← api, tests: Merge",
      collapsed: shapeLine([
        { key: "api", inputs: [] },
        { key: "tests", inputs: [] },
        { key: "merge", inputs: ["api", "tests"] },
      ]),
    };
    expect(formatCall("spawn graph", view, false, plain)).toBe(
      "✦ spawn graph review\n  failFast=true\n  {api, tests} → merge",
    );
    expect(formatCall("spawn graph", view, true, plain)).toBe(
      "✦ spawn graph review\n  failFast=true\n  api (model=sol): Map the API\n  tests: Check the tests\n  merge ← api, tests: Merge",
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
