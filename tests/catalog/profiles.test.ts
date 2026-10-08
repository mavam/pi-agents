import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  discoverProfiles,
  findProfile,
  parseProfileFile,
} from "../../src/catalog/profiles.js";

function write(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("profiles", () => {
  test("parses frontmatter and keeps absent skills absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-profile-"));
    const file = write(
      dir,
      "planner.md",
      "---\nname: planner\ndescription: Plans\nmodel: openai/gpt\nthinking: high\ntools: read, grep\n---\n\nPlan carefully.\n",
    );
    expect(parseProfileFile(file, "project")).toEqual({
      name: "planner",
      description: "Plans",
      model: "openai/gpt",
      thinking: "high",
      tools: ["read", "grep"],
      instructions: "Plan carefully.",
      source: "project",
      filePath: file,
    });
  });

  test("keeps an explicitly empty skill list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-profile-"));
    const file = write(
      dir,
      "a.md",
      "---\nname: a\ndescription: A\nskills: []\n---\n",
    );
    const profile = parseProfileFile(file, "user");
    expect(typeof profile !== "string" && profile.skills).toEqual([]);
  });

  test("reports invalid frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-profile-"));
    expect(
      parseProfileFile(write(dir, "a.md", "---\nname: a\n---\n"), "user"),
    ).toContain("description");
    expect(
      parseProfileFile(
        write(
          dir,
          "b.md",
          "---\nname: b\ndescription: B\nthinking: huge\n---\n",
        ),
        "user",
      ),
    ).toContain("thinking");
    expect(
      parseProfileFile(
        write(dir, "c.md", "---\nname: c\ndescription: C\nflow: x\n---\n"),
        "user",
      ),
    ).toContain("Unsupported frontmatter keys: flow");
  });

  test("project profiles override user profiles", () => {
    write(
      path.join(getAgentDir(), "agents"),
      "shared.md",
      "---\nname: shared\ndescription: user\n---\n",
    );
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-project-"),
    );
    write(
      path.join(project, ".pi", "agents"),
      "shared.md",
      "---\nname: shared\ndescription: project\n---\n",
    );
    const both = discoverProfiles(project, "both").profiles;
    expect(findProfile(both, "shared")?.description).toBe("project");
    expect(findProfile(both, "SHARED")?.description).toBe("project");
    const user = discoverProfiles(project, "user").profiles;
    expect(findProfile(user, "shared")?.description).toBe("user");
  });
});
