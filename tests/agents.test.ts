import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAgentsPrompt,
  buildSkillsPrompt,
  discoverAgents,
  formatAgentList,
} from "../src/catalog/agents.ts";
import {
  formatWorkflowAgentsXml,
  shouldInjectWorkflowAgentsPrompt,
} from "../src/catalog/workflow-agent-prompt.ts";

let sandboxDir = "";
let workspaceDir = "";
let previousAgentDir: string | undefined;

function userAgentsDir(): string {
  return path.join(sandboxDir, ".pi", "agents");
}

function setupProject(): { projectAgentsDir: string; cwd: string } {
  const projectRoot = path.join(sandboxDir, "project");
  const projectAgentsDir = path.join(projectRoot, ".pi", "agents");
  const cwd = path.join(projectRoot, "apps", "api", "src");
  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { projectAgentsDir, cwd };
}

function createAgentMarkdown(params: {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  skills?: string[];
  prompt?: string;
  extraFrontmatter?: string[];
}): string {
  const {
    name,
    description,
    model = "openai-codex/gpt-5.3-codex-spark",
    thinking = "low",
    skills = ["search"],
    prompt = "Do the thing.",
    extraFrontmatter = [],
  } = params;

  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `model: ${model}`,
    `thinking: ${thinking}`,
    "skills:",
    ...skills.map((skill) => `  - ${skill}`),
    ...extraFrontmatter,
    "---",
    "",
    prompt,
    "",
  ];

  return lines.join("\n");
}

function writeAgentFile(
  dir: string,
  fileName: string,
  content: string,
): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

beforeEach(() => {
  sandboxDir = mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), "pi-agents-workspace-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(sandboxDir, ".pi", "agent");
  mkdirSync(userAgentsDir(), { recursive: true });
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("discoverAgents", () => {
  it("loads user agents from ~/.pi/agents", () => {
    writeAgentFile(
      userAgentsDir(),
      "explorer.md",
      createAgentMarkdown({ name: "explorer", description: "User explorer" }),
    );

    const result = discoverAgents(workspaceDir, "user");

    expect(result.projectAgentsDir).toBeNull();
    expect(result.diagnostics).toHaveLength(0);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.name).toBe("explorer");
    expect(result.agents[0]?.source).toBe("user");
  });

  it("finds nearest project agents directory by walking up from cwd", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      projectAgentsDir,
      "explorer.md",
      createAgentMarkdown({
        name: "explorer",
        description: "Project explorer",
      }),
    );

    const result = discoverAgents(cwd, "project");

    expect(result.projectAgentsDir).toBe(projectAgentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.source).toBe("project");
  });

  it("scope=user ignores project agents", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      userAgentsDir(),
      "explorer.md",
      createAgentMarkdown({ name: "explorer", description: "User explorer" }),
    );
    writeAgentFile(
      projectAgentsDir,
      "project-only.md",
      createAgentMarkdown({
        name: "project-only",
        description: "Project only",
      }),
    );

    const result = discoverAgents(cwd, "user");
    const names = result.agents.map((agent) => agent.name);

    expect(names).toContain("explorer");
    expect(names).not.toContain("project-only");
  });

  it("scope=project ignores user agents", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      userAgentsDir(),
      "user-only.md",
      createAgentMarkdown({ name: "user-only", description: "User only" }),
    );
    writeAgentFile(
      projectAgentsDir,
      "explorer.md",
      createAgentMarkdown({
        name: "explorer",
        description: "Project explorer",
      }),
    );

    const result = discoverAgents(cwd, "project");
    const names = result.agents.map((agent) => agent.name);

    expect(names).toContain("explorer");
    expect(names).not.toContain("user-only");
  });

  it("does not treat ~/.pi/agents as project agents while walking parent directories", () => {
    writeAgentFile(
      userAgentsDir(),
      "explorer.md",
      createAgentMarkdown({ name: "explorer", description: "User explorer" }),
    );
    const cwd = path.join(sandboxDir, "no-project", "nested");
    mkdirSync(cwd, { recursive: true });

    const projectResult = discoverAgents(cwd, "project");
    expect(projectResult.projectAgentsDir).toBeNull();
    expect(projectResult.agents).toHaveLength(0);

    const bothResult = discoverAgents(cwd, "both");
    expect(bothResult.projectAgentsDir).toBeNull();
    expect(bothResult.agents).toHaveLength(1);
    expect(bothResult.agents[0]?.source).toBe("user");
  });

  it("scope=both merges user and project, with project winning on name conflicts", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      userAgentsDir(),
      "explorer.md",
      createAgentMarkdown({ name: "explorer", description: "User explorer" }),
    );
    writeAgentFile(
      projectAgentsDir,
      "explorer.md",
      createAgentMarkdown({
        name: "explorer",
        description: "Project explorer",
      }),
    );

    const result = discoverAgents(cwd, "both");
    const explorer = result.agents.find((agent) => agent.name === "explorer");

    expect(result.agents).toHaveLength(1);
    expect(explorer?.source).toBe("project");
    expect(explorer?.description).toBe("Project explorer");
  });

  it("reports invalid frontmatter and skips invalid files", () => {
    writeAgentFile(
      userAgentsDir(),
      "invalid.md",
      createAgentMarkdown({
        name: "bad",
        description: "Bad agent",
        extraFrontmatter: ["foo: bar"],
      }),
    );

    const result = discoverAgents(workspaceDir, "user");

    expect(result.agents).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "Unsupported frontmatter keys",
    );
  });

  it("reports malformed frontmatter without aborting discovery", () => {
    writeAgentFile(
      userAgentsDir(),
      "broken.md",
      [
        "---",
        "name: broken",
        'description: "unterminated',
        "---",
        "",
        "Broken agent body.",
        "",
      ].join("\n"),
    );
    writeAgentFile(
      userAgentsDir(),
      "explorer.md",
      createAgentMarkdown({ name: "explorer", description: "User explorer" }),
    );

    const result = discoverAgents(workspaceDir, "user");

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.name).toBe("explorer");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "Could not parse frontmatter",
    );
  });
});

describe("formatAgentList", () => {
  it("returns 'none' for empty input", () => {
    expect(formatAgentList([])).toBe("none");
  });
});

describe("formatWorkflowAgentsXml", () => {
  it("renders a deterministic workflow agent catalog", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      userAgentsDir(),
      "zeta.md",
      createAgentMarkdown({ name: "zeta", description: "User zeta" }),
    );
    writeAgentFile(
      projectAgentsDir,
      "worker.md",
      createAgentMarkdown({ name: "worker", description: "Project worker" }),
    );

    const xml = formatWorkflowAgentsXml(cwd, "both");

    expect(xml).toContain('<workflow-agents scope="both"');
    expect(xml).toContain('<agent name="worker" source="project"');
    expect(xml).toContain('<agent name="zeta" source="user"');
    expect(xml.indexOf('name="worker"')).toBeLessThan(
      xml.indexOf('name="zeta"'),
    );
    expect(xml).toContain(
      '<valid>{"agent":"worker","task":"Map the public API."}</valid>',
    );
    expect(xml).toContain('reason="invented-name"');
  });

  it("reports when no agents are available", () => {
    const xml = formatWorkflowAgentsXml(workspaceDir, "both");

    expect(xml).toContain("No workflow agents were discovered");
  });
});

describe("shouldInjectWorkflowAgentsPrompt", () => {
  it("detects explicit orchestration intent", () => {
    expect(
      shouldInjectWorkflowAgentsPrompt(
        "Use the workflow tool to fork this review into parallel branches.",
      ),
    ).toBe(true);
    expect(
      shouldInjectWorkflowAgentsPrompt("Please spawn 3 agents to audit this."),
    ).toBe(true);
    expect(
      shouldInjectWorkflowAgentsPrompt("Just fix the lint error in this file."),
    ).toBe(false);
  });

  it("stays enabled for the turn after workflow use", () => {
    expect(
      shouldInjectWorkflowAgentsPrompt("continue", {
        workflowUsedInPreviousTurn: true,
      }),
    ).toBe(true);
  });
});

describe("buildAgentsPrompt", () => {
  it("renders agent metadata and system prompts from discovered files", () => {
    const { projectAgentsDir, cwd } = setupProject();
    writeAgentFile(
      projectAgentsDir,
      "worker.md",
      createAgentMarkdown({
        name: "worker",
        description: "Project worker",
        thinking: "medium",
        skills: ["code-review"],
        prompt: "Run delegated work.",
      }),
    );

    const { prompt, diagnostics } = buildAgentsPrompt(cwd, "both");

    expect(diagnostics).toHaveLength(0);
    expect(prompt).toContain(`<agents scope="both" cwd="${cwd}">`);
    expect(prompt).toContain(
      `<agent name="worker" source="project" location="${path.join(projectAgentsDir, "worker.md")}">`,
    );
    expect(prompt).toContain("<references>References are relative to");
    expect(prompt).toContain("<frontmatter>");
    expect(prompt).toContain("<description>Project worker</description>");
    expect(prompt).toContain("<model>openai-codex/gpt-5.3-codex-spark</model>");
    expect(prompt).toContain("<thinking>medium</thinking>");
    expect(prompt).toContain("<skill>code-review</skill>");
    expect(prompt).toContain("<system-prompt>");
    expect(prompt).toContain("Run delegated work.");
  });
});

describe("buildSkillsPrompt", () => {
  it("loads project skills from nearest ancestor when cwd is nested", () => {
    const projectRoot = path.join(sandboxDir, "project");
    const nestedCwd = path.join(projectRoot, "apps", "api", "src");
    const projectSkillsDir = path.join(projectRoot, ".pi", "skills", "search");

    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(
      path.join(projectSkillsDir, "SKILL.md"),
      [
        "---",
        "name: search",
        "description: Project search helpers",
        "---",
        "",
        "Use ripgrep for fast project searches.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const { prompt, missingSkills } = buildSkillsPrompt(["search"], nestedCwd);

    expect(missingSkills).toHaveLength(0);
    expect(prompt).toContain('<skill name="search"');
    expect(prompt).toContain("Use ripgrep for fast project searches.");
  });
});
