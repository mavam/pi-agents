import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CatalogCache,
  type InvocationCall,
  resolveInvocation,
} from "../../src/run/invocation.js";

let projectDir: string;

function writeAgent(
  dir: string,
  name: string,
  frontmatter: Record<string, string> = {},
): void {
  const agentsDir = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const extra = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("");
  fs.writeFileSync(
    path.join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: d\n${extra}---\nPersona of ${name}.\n`,
  );
}

function writeSkill(
  skillsDir: string,
  name: string,
  body = "Do the thing.",
): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
  );
}

function projectSkills(dir: string): string {
  return path.join(dir, ".pi", "skills");
}

function userSkills(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR as string, "skills");
}

/** `~/.agents/skills` under the suite's temp HOME (see tests/setup.ts). */
function homeAgentsSkills(): string {
  return path.join(process.env.HOME as string, ".agents", "skills");
}

/** Resolve against `projectDir` with project trust, or fail the test. */
function resolve(call: InvocationCall, trusted = true) {
  const resolution = resolveInvocation(call, {
    cwd: projectDir,
    scope: "both",
    trusted,
    catalogs: new CatalogCache(),
  });
  return resolution;
}

function resolveOk(call: InvocationCall, trusted = true) {
  const resolution = resolve(call, trusted);
  if (!resolution.ok)
    throw new Error(`unexpected failure: ${resolution.problems.join("; ")}`);
  return resolution.invocation;
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-inv-"));
  fs.mkdirSync(projectSkills(projectDir), { recursive: true });
  writeSkill(projectSkills(projectDir), "code-review");
  writeSkill(projectSkills(projectDir), "gh");
  fs.mkdirSync(userSkills(), { recursive: true });
  writeSkill(userSkills(), "user-only");
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(userSkills(), { recursive: true, force: true });
});

describe("skills and tools precedence", () => {
  // One table over the whole matrix: omitted inherits, an explicit list
  // replaces, and [] clears — for named and anonymous calls alike.
  const cases: Array<{
    what: string;
    call: InvocationCall;
    skills: string[];
    disableSkillDiscovery: boolean;
    tools?: string[];
  }> = [
    {
      what: "anonymous omitted → nothing forced",
      call: {},
      skills: [],
      disableSkillDiscovery: false,
      tools: undefined,
    },
    {
      what: "anonymous explicit → exactly what was asked",
      call: { skills: ["code-review"], tools: ["read"] },
      skills: ["code-review"],
      disableSkillDiscovery: true,
      tools: ["read"],
    },
    {
      what: "anonymous empty → cleared",
      call: { skills: [], tools: [] },
      skills: [],
      disableSkillDiscovery: true,
      tools: [],
    },
    {
      what: "named omitted → inherits the profile",
      call: { agent: "reviewer" },
      skills: ["code-review"],
      disableSkillDiscovery: true,
      tools: ["read", "grep"],
    },
    {
      what: "named explicit → replaces the profile",
      call: { agent: "reviewer", skills: ["gh"], tools: ["find"] },
      skills: ["gh"],
      disableSkillDiscovery: true,
      tools: ["find"],
    },
    {
      what: "named empty → clears the profile",
      call: { agent: "reviewer", skills: [], tools: [] },
      skills: [],
      disableSkillDiscovery: true,
      tools: [],
    },
  ];

  for (const { what, call, skills, disableSkillDiscovery, tools } of cases) {
    test(what, () => {
      writeAgent(projectDir, "reviewer", {
        skills: "[code-review]",
        tools: "[read, grep]",
      });
      const invocation = resolveOk(call);
      expect(invocation.skills.map((s) => s.name)).toEqual(skills);
      expect(invocation.disableSkillDiscovery).toBe(disableSkillDiscovery);
      expect(invocation.tools).toEqual(tools);
    });
  }

  test("a named profile without skills still closes ambient discovery", () => {
    writeAgent(projectDir, "reviewer");
    const invocation = resolveOk({ agent: "reviewer" });
    expect(invocation.skills).toEqual([]);
    expect(invocation.disableSkillDiscovery).toBe(true);
  });

  test("rejects orchestration tools inherited from a named profile", () => {
    writeAgent(projectDir, "reviewer", {
      tools: "[read, workflow_create]",
    });
    const resolution = resolve({ agent: "reviewer" });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected resolution failure");
    expect(resolution.problems.join("\n")).toContain(
      "delegated agents cannot use orchestration tools (workflow_create)",
    );
    expect(resolution.problems.join("\n")).toContain(
      "compose the work in the parent flow",
    );

    writeAgent(projectDir, "legacy-reviewer", { tools: "[steer]" });
    const legacy = resolve({ agent: "legacy-reviewer" });
    expect(legacy.ok).toBe(false);
    if (legacy.ok) throw new Error("expected legacy resolution failure");
    expect(legacy.problems.join("\n")).toContain(
      "delegated agents cannot use orchestration tools (steer)",
    );
  });

  test("a call-site tool list replaces a forbidden profile list", () => {
    writeAgent(projectDir, "reviewer", {
      tools: "[workflow_create]",
    });
    expect(resolveOk({ agent: "reviewer", tools: ["read"] }).tools).toEqual([
      "read",
    ]);
  });

  test("model and thinking follow call → profile → session default", () => {
    writeAgent(projectDir, "reviewer", {
      model: "profile-model",
      thinking: "medium",
    });
    const catalogs = new CatalogCache();
    const context = {
      cwd: projectDir,
      scope: "both" as const,
      trusted: true,
      defaults: { model: "session-model", thinking: "low" },
      catalogs,
    };

    const call = resolveInvocation(
      { agent: "reviewer", model: "call-model" },
      context,
    );
    const profile = resolveInvocation({ agent: "reviewer" }, context);
    const session = resolveInvocation({}, context);
    if (!call.ok || !profile.ok || !session.ok)
      throw new Error("resolution failed");

    expect(call.invocation.model).toBe("call-model");
    expect(call.invocation.thinking).toBe("medium");
    expect(profile.invocation.model).toBe("profile-model");
    expect(session.invocation.model).toBe("session-model");
    expect(session.invocation.thinking).toBe("low");
  });
});

describe("model resolution", () => {
  const resolveModel = (ref: string) =>
    ref === "terra"
      ? ({ ok: true, model: "openai-codex/terra" } as const)
      : ({
          ok: false,
          message: `unknown model '${ref}' — available: openai-codex/terra`,
        } as const);

  test("validates and canonicalizes a node model", () => {
    const resolution = resolveInvocation(
      { model: "terra" },
      {
        cwd: projectDir,
        scope: "both",
        trusted: true,
        resolveModel,
        catalogs: new CatalogCache(),
      },
    );
    if (!resolution.ok) throw new Error(resolution.problems.join("; "));
    expect(resolution.invocation.model).toBe("openai-codex/terra");
  });

  test("validates and canonicalizes a profile model", () => {
    writeAgent(projectDir, "terra-agent", { model: "terra" });
    const resolution = resolveInvocation(
      { agent: "terra-agent" },
      {
        cwd: projectDir,
        scope: "both",
        trusted: true,
        resolveModel,
        catalogs: new CatalogCache(),
      },
    );
    if (!resolution.ok) throw new Error(resolution.problems.join("; "));
    expect(resolution.invocation.model).toBe("openai-codex/terra");
  });

  test("does not validate the session-default model", () => {
    let calls = 0;
    const resolution = resolveInvocation(
      {},
      {
        cwd: projectDir,
        scope: "both",
        trusted: true,
        defaults: { model: "session/model" },
        resolveModel: (ref) => {
          calls += 1;
          return resolveModel(ref);
        },
        catalogs: new CatalogCache(),
      },
    );
    if (!resolution.ok) throw new Error(resolution.problems.join("; "));
    expect(resolution.invocation.model).toBe("session/model");
    expect(calls).toBe(0);
  });

  test("puts model failures in problems with resolution context", () => {
    const resolution = resolveInvocation(
      { model: "missing" },
      {
        cwd: projectDir,
        scope: "both",
        trusted: true,
        resolveModel,
        catalogs: new CatalogCache(),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.problems[0]).toContain("unknown model 'missing'");
    expect(resolution.problems[0]).toContain(`cwd: ${projectDir}`);
    expect(resolution.problems[0]).toContain("scope: both");
  });

  test("keeps existing behavior when no resolver is supplied", () => {
    expect(resolveOk({ model: "anything" }).model).toBe("anything");
  });
});

describe("skill resolution", () => {
  test("resolved skills carry their instructions", () => {
    const invocation = resolveOk({ skills: ["code-review"] });
    expect(invocation.skills[0]).toMatchObject({
      name: "code-review",
      instructions: "Do the thing.",
    });
    expect(invocation.skills[0]?.filePath).toContain("code-review");
  });

  test("an unknown skill reports the discovery context and what exists", () => {
    const resolution = resolve({ skills: ["code-reveiw"] });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.problems[0]).toContain("unknown skill 'code-reveiw'");
    expect(resolution.problems[0]).toContain(`cwd: ${projectDir}`);
    expect(resolution.problems[0]).toContain("scope: both");
    expect(resolution.problems[0]).toContain("code-review");
  });

  test("a skill that vanishes after discovery fails instead of degrading", () => {
    // Discovery parses frontmatter, so a file unreadable from the start is
    // simply absent ("unknown"). The "unreadable" path covers the race where
    // the file goes away between discovery and the body read.
    const catalogs = new CatalogCache();
    const context = {
      cwd: projectDir,
      scope: "both" as const,
      trusted: true,
      catalogs,
    };
    expect(resolveInvocation({ skills: ["code-review"] }, context).ok).toBe(
      true,
    );
    fs.rmSync(path.join(projectSkills(projectDir), "gh", "SKILL.md"));

    const resolution = resolveInvocation({ skills: ["gh"] }, context);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok)
      expect(resolution.problems[0]).toContain("unreadable skill 'gh'");
  });

  test("every problem in one invocation is reported together", () => {
    const resolution = resolve({ agent: "nobody", skills: ["nothing"] });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.problems).toHaveLength(2);
    expect(resolution.problems.join("; ")).toContain("unknown agent 'nobody'");
    expect(resolution.problems.join("; ")).toContain("unknown skill 'nothing'");
  });

  test("profile-declared skills resolve, and a stale one fails the call", () => {
    writeAgent(projectDir, "good", { skills: "[gh]" });
    writeAgent(projectDir, "stale", { skills: "[gone]" });
    expect(resolveOk({ agent: "good" }).skills.map((s) => s.name)).toEqual([
      "gh",
    ]);
    const resolution = resolve({ agent: "stale" });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok)
      expect(resolution.problems[0]).toContain("unknown skill 'gone'");
  });
});

describe("scope and trust", () => {
  test("user scope sees only user skills", () => {
    const resolution = resolveInvocation(
      { skills: ["code-review"], scope: "user" },
      {
        cwd: projectDir,
        scope: "both",
        trusted: true,
        catalogs: new CatalogCache(),
      },
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.scope).toBe("user");
      expect(resolution.problems[0]).toContain("unknown skill 'code-review'");
      expect(resolution.problems[0]).toContain("user-only");
    }
    expect(
      resolveOk({ skills: ["user-only"], scope: "user" }).skills,
    ).toHaveLength(1);
  });

  test("an untrusted project cannot contribute skills", () => {
    const resolution = resolve({ skills: ["code-review"] }, false);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      // Scope clamps to user, so the project skill is invisible.
      expect(resolution.scope).toBe("user");
      expect(resolution.problems[0]).toContain("unknown skill 'code-review'");
    }
    expect(resolveOk({ skills: ["user-only"] }, false).skills).toHaveLength(1);
  });

  test("a cwd override selects the project the skills come from", () => {
    const other = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-inv-other-"),
    );
    try {
      writeSkill(projectSkills(other), "other-only");
      const invocation = resolveOk({ skills: ["other-only"], cwd: other });
      expect(invocation.cwd).toBe(other);
      expect(invocation.skills[0]?.name).toBe("other-only");
      // ...and the original project's skills are no longer in reach.
      expect(resolve({ skills: ["code-review"], cwd: other }).ok).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("one project root per cwd", () => {
  test("a nested .pi shadows the outer one for every resource kind", () => {
    // Outer project holds the profile, inner project holds the skill: walking
    // per resource kind would combine them.
    writeAgent(projectDir, "outer-reviewer");
    const inner = path.join(projectDir, "sub");
    writeSkill(projectSkills(inner), "inner-only");

    const resolution = resolveInvocation(
      { agent: "outer-reviewer", skills: ["inner-only"] },
      {
        cwd: inner,
        scope: "both",
        trusted: true,
        catalogs: new CatalogCache(),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    // The inner root wins: its skill resolves, the outer profile does not.
    expect(resolution.problems).toHaveLength(1);
    expect(resolution.problems[0]).toContain("unknown agent 'outer-reviewer'");
  });

  test("without a nested .pi both come from the outer root", () => {
    writeAgent(projectDir, "outer-reviewer", { skills: "[code-review]" });
    const inner = path.join(projectDir, "sub", "deeper");
    fs.mkdirSync(inner, { recursive: true });
    const resolution = resolveInvocation(
      { agent: "outer-reviewer" },
      {
        cwd: inner,
        scope: "both",
        trusted: true,
        catalogs: new CatalogCache(),
      },
    );
    if (!resolution.ok) throw new Error(resolution.problems.join("; "));
    expect(resolution.invocation.profile?.name).toBe("outer-reviewer");
    expect(resolution.invocation.skills.map((s) => s.name)).toEqual([
      "code-review",
    ]);
  });
});

describe("pi's skill locations", () => {
  // pi advertises skills from .pi/skills and .agents/skills, user and project
  // alike. A name taken from <available_skills> must resolve here.
  test("user .agents/skills is part of the catalog", () => {
    const dir = homeAgentsSkills();
    writeSkill(dir, "home-agents-skill");
    try {
      const invocation = resolveOk({ skills: ["home-agents-skill"] });
      expect(invocation.skills[0]?.filePath).toContain(
        path.join(".agents", "skills", "home-agents-skill"),
      );
    } finally {
      fs.rmSync(path.join(dir, "home-agents-skill"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("project .agents/skills is found from the cwd up to the git root", () => {
    // Git root at the top, cwd two levels below it, skill in between.
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
    const middle = path.join(projectDir, "pkg");
    const deep = path.join(middle, "src");
    fs.mkdirSync(deep, { recursive: true });
    writeSkill(path.join(middle, ".agents", "skills"), "ancestor-skill");

    const invocation = resolveOk({ skills: ["ancestor-skill"], cwd: deep });
    expect(invocation.skills[0]?.filePath).toContain(
      path.join("pkg", ".agents", "skills", "ancestor-skill"),
    );
  });

  test("the walk stops at the git root", () => {
    // A .agents/skills above the repo root must not leak into the project.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-outer-"));
    try {
      const repo = path.join(outer, "repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      writeSkill(path.join(outer, ".agents", "skills"), "too-far");
      const resolution = resolveInvocation(
        { skills: ["too-far"] },
        {
          cwd: repo,
          scope: "both",
          trusted: true,
          catalogs: new CatalogCache(),
        },
      );
      expect(resolution.ok).toBe(false);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  test("an untrusted project contributes no .agents skills either", () => {
    writeSkill(path.join(projectDir, ".agents", "skills"), "project-agents");
    expect(resolve({ skills: ["project-agents"] }, false).ok).toBe(false);
    expect(resolveOk({ skills: ["project-agents"] }, true).skills).toHaveLength(
      1,
    );
  });

  test("the first directory defining a name wins, project before user", () => {
    // Same order pi resolves in, so a name means the same file here as in
    // <available_skills>.
    writeSkill(projectSkills(projectDir), "shared", "Project instructions.");
    writeSkill(userSkills(), "shared", "User instructions.");
    expect(resolveOk({ skills: ["shared"] }).skills[0]?.instructions).toBe(
      "Project instructions.",
    );
    // Under user scope the project copy is out of reach entirely.
    expect(
      resolveOk({ skills: ["shared"], scope: "user" }).skills[0]?.instructions,
    ).toBe("User instructions.");
  });

  test("collisions are recorded rather than hidden", () => {
    writeSkill(projectSkills(projectDir), "shared", "Project instructions.");
    writeSkill(userSkills(), "shared", "User instructions.");
    const catalogs = new CatalogCache();
    catalogs.skillsFor(projectDir, "both");
    const catalog = catalogs.skillsFor(projectDir, "both");
    expect(catalog.collisions).toHaveLength(1);
    expect(catalog.collisions[0]).toMatchObject({ name: "shared" });
    expect(catalog.collisions[0]?.winner).toContain(".pi");
  });
});

describe("catalog cache", () => {
  test("invocations without skills never scan the catalog", () => {
    const catalogs = new CatalogCache();
    const context = {
      cwd: projectDir,
      scope: "both" as const,
      trusted: true,
      catalogs,
    };
    writeAgent(projectDir, "plain");
    resolveInvocation({}, context);
    resolveInvocation({ agent: "plain" }, context);
    resolveInvocation({ skills: [] }, context);
    expect(catalogs.skillScans).toBe(0);

    resolveInvocation({ skills: ["code-review"] }, context);
    expect(catalogs.skillScans).toBe(1);
  });

  test("a shared cache reads each skill body once", () => {
    const catalogs = new CatalogCache();
    const context = {
      cwd: projectDir,
      scope: "both" as const,
      trusted: true,
      catalogs,
    };
    const first = resolveInvocation({ skills: ["code-review"] }, context);
    const filePath = path.join(
      projectSkills(projectDir),
      "code-review",
      "SKILL.md",
    );
    // Deleting the file after the first resolution proves the body was cached:
    // a second resolution through the same cache still succeeds.
    fs.rmSync(filePath);
    const second = resolveInvocation({ skills: ["code-review"] }, context);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
