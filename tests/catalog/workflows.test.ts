import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverWorkflows,
  parseWorkflowFile,
} from "../../src/catalog/workflows.js";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "workflows"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeWorkflow(name: string, content: string): string {
  const filePath = path.join(projectDir, ".pi", "workflows", `${name}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const REVIEW = `---
name: review
description: Multi-lens code review
whenToUse: when the user asks for a thorough review
params:
  - name: target
    required: true
  - depth
flow:
  kind: par
  branches:
    bugs: { kind: agent, name: reviewer, task: "Find bugs in {params.target}" }
    style: { kind: agent, name: reviewer, task: "Check style in {params.target}" }
  reduce: { agent: synthesizer, task: "Merge {branches}" }
---

Reviews {target} from two lenses.
`;

describe("parseWorkflowFile", () => {
  test("parses a workflow with flow: in frontmatter", () => {
    const filePath = writeWorkflow("review", REVIEW);
    const result = parseWorkflowFile(filePath, "project");
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;
    expect(result.name).toBe("review");
    expect(result.description).toBe("Multi-lens code review");
    expect(result.whenToUse).toContain("thorough review");
    expect(result.params).toEqual([
      {
        name: "target",
        description: undefined,
        required: true,
        default: undefined,
      },
      { name: "depth" },
    ]);
    expect(result.flow.kind).toBe("par");
    expect(result.doc).toBe("Reviews {target} from two lenses.");
  });

  test("flat agent form normalizes to a bare agent leaf", () => {
    const filePath = writeWorkflow(
      "bug-hunt",
      `---
name: bug-hunt
description: Hunt bugs in a target
params:
  - { name: target, required: true }
agent: reviewer
task: "Review {params.target} strictly for bugs."
model: cheap-model
thinking: low
---

Single-unit workflow.
`,
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.flow).toMatchObject({
      kind: "agent",
      name: "reviewer",
      task: "Review {params.target} strictly for bugs.",
      model: "cheap-model",
      thinking: "low",
    });
  });

  test("flat form without a task relies on the agent-file default", () => {
    const filePath = writeWorkflow(
      "just-agent",
      "---\nname: just-agent\ndescription: d\nagent: reviewer\n---\n",
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.flow).toMatchObject({ kind: "agent", name: "reviewer" });
    expect((result.flow as { task?: string }).task).toBeUndefined();
  });

  test("requires flow: or the flat form", () => {
    const filePath = writeWorkflow(
      "empty",
      "---\nname: empty\ndescription: d\n---\nNo flow here.\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "No flow found: add a 'flow:' key",
    );
  });

  test("rejects mixing flow: with the flat form", () => {
    const filePath = writeWorkflow(
      "mixed",
      "---\nname: mixed\ndescription: d\nagent: reviewer\nflow: { kind: agent, name: reviewer, task: t }\n---\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain("not both");
  });

  test("rejects flat-form keys next to flow:", () => {
    const filePath = writeWorkflow(
      "stray",
      "---\nname: stray\ndescription: d\ntask: t\nflow: { kind: agent, name: reviewer, task: t }\n---\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "'task' belongs to the flat agent form",
    );
  });

  test("rejects unknown frontmatter keys", () => {
    const filePath = writeWorkflow(
      "bad",
      "---\nname: bad\ndescription: d\nmodell: x\nflow: { kind: agent, name: a, task: t }\n---\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "Unsupported frontmatter keys: modell",
    );
  });

  test("rejects invalid names and debounce", () => {
    const badName = writeWorkflow(
      "badname",
      "---\nname: 'bad name'\ndescription: d\nflow: { kind: agent, name: a, task: t }\n---\n",
    );
    expect(parseWorkflowFile(badName, "project")).toContain("invalid 'name'");
    const badDebounce = writeWorkflow(
      "baddeb",
      "---\nname: baddeb\ndescription: d\ndebounce: -5\nflow: { kind: agent, name: a, task: t }\n---\n",
    );
    expect(parseWorkflowFile(badDebounce, "project")).toContain(
      "Invalid 'debounce'",
    );
  });

  test("structurally invalid flow is reported with node paths", () => {
    const filePath = writeWorkflow(
      "badflow",
      "---\nname: badflow\ndescription: d\nflow: { kind: spawn, agent: a }\n---\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "unknown kind 'spawn'",
    );
  });

  test("hook workflows get the implicit event param", () => {
    const filePath = writeWorkflow(
      "hooked",
      `---
name: hooked
description: d
on: [turn_end]
debounce: 60000
flow: { kind: agent, name: a, task: "look at {params.event}" }
---
`,
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.on).toEqual(["turn_end"]);
    expect(result.debounce).toBe(60000);
    expect(result.params.map((p) => p.name)).toContain("event");
  });
});

describe("discoverWorkflows", () => {
  test("cross-validates references between workflows", () => {
    writeWorkflow("review", REVIEW);
    writeWorkflow(
      "fixit",
      `---
name: fixit
description: review then fix
flow:
  kind: seq
  steps:
    - { kind: workflow, name: review, params: { target: "src/" }, as: rev }
    - { kind: agent, name: worker, task: "Fix: {rev}" }
---
`,
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics).toEqual([]);
    expect(workflows.map((wf) => wf.name).sort()).toEqual(["fixit", "review"]);
  });

  test("excludes workflows whose flow fails validation", () => {
    writeWorkflow(
      "broken",
      `---
name: broken
description: d
flow: { kind: agent, name: a, task: "use {nothere}" }
---
`,
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics[0]?.message).toContain("unknown reference {nothere}");
  });

  test("detects cycles across saved workflows", () => {
    writeWorkflow(
      "a",
      "---\nname: a\ndescription: d\nflow: { kind: workflow, name: b }\n---\n",
    );
    writeWorkflow(
      "b",
      "---\nname: b\ndescription: d\nflow: { kind: workflow, name: a }\n---\n",
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics.map((d) => d.message).join("\n")).toContain(
      "workflow cycle",
    );
  });

  test("unknown references to other workflows are diagnosed", () => {
    writeWorkflow(
      "solo",
      "---\nname: solo\ndescription: d\nflow: { kind: workflow, name: ghost }\n---\n",
    );
    const { diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics[0]?.message).toContain("unknown workflow 'ghost'");
  });
});
