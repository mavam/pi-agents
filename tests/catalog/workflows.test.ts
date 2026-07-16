import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverWorkflows,
  extractFlowBlocks,
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
---

Reviews {target} from two lenses.

\`\`\`yaml
kind: par
branches:
  bugs: { kind: agent, name: reviewer, task: "Find bugs in {params.target}" }
  style: { kind: agent, name: reviewer, task: "Check style in {params.target}" }
reduce: { agent: synthesizer, task: "Merge {branches}" }
\`\`\`
`;

describe("parseWorkflowFile", () => {
  test("parses a valid workflow", () => {
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
    expect(result.doc).toContain("Reviews {target} from two lenses.");
    expect(result.doc).not.toContain("kind: par");
  });

  test("requires a flow block", () => {
    const filePath = writeWorkflow(
      "empty",
      "---\nname: empty\ndescription: d\n---\nNo flow here.\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain("No flow found");
  });

  test("rejects multiple flow blocks", () => {
    const filePath = writeWorkflow(
      "double",
      '---\nname: double\ndescription: d\n---\n```json\n{"kind":"agent","name":"a","task":"t"}\n```\n\n```yaml\nkind: agent\nname: b\ntask: t\n```\n',
    );
    expect(parseWorkflowFile(filePath, "project")).toContain("exactly one");
  });

  test("rejects unknown frontmatter keys", () => {
    const filePath = writeWorkflow(
      "bad",
      "---\nname: bad\ndescription: d\nmodel: x\n---\n```yaml\nkind: agent\nname: a\ntask: t\n```\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "Unsupported frontmatter keys: model",
    );
  });

  test("rejects invalid names and debounce", () => {
    const badName = writeWorkflow(
      "badname",
      "---\nname: 'bad name'\ndescription: d\n---\n```yaml\nkind: agent\nname: a\ntask: t\n```\n",
    );
    expect(parseWorkflowFile(badName, "project")).toContain("invalid 'name'");
    const badDebounce = writeWorkflow(
      "baddeb",
      "---\nname: baddeb\ndescription: d\ndebounce: -5\n---\n```yaml\nkind: agent\nname: a\ntask: t\n```\n",
    );
    expect(parseWorkflowFile(badDebounce, "project")).toContain(
      "Invalid 'debounce'",
    );
  });

  test("structurally invalid flow is reported with node paths", () => {
    const filePath = writeWorkflow(
      "badflow",
      "---\nname: badflow\ndescription: d\n---\n```yaml\nkind: spawn\nagent: a\n```\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "unknown kind 'spawn'",
    );
  });

  test("hook workflows get the implicit event param", () => {
    const filePath = writeWorkflow(
      "hooked",
      '---\nname: hooked\ndescription: d\non: [turn_end]\ndebounce: 60000\n---\n```yaml\nkind: agent\nname: a\ntask: "look at {params.event}"\n```\n',
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.on).toEqual(["turn_end"]);
    expect(result.debounce).toBe(60000);
    expect(result.params.map((p) => p.name)).toContain("event");
  });

  test("json flow blocks parse too", () => {
    const filePath = writeWorkflow(
      "jsonwf",
      '---\nname: jsonwf\ndescription: d\n---\n```json\n{"kind":"agent","name":"a","task":"t"}\n```\n',
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.flow).toMatchObject({ kind: "agent", name: "a" });
  });
});

describe("discoverWorkflows", () => {
  test("cross-validates references between workflows", () => {
    writeWorkflow("review", REVIEW);
    writeWorkflow(
      "fixit",
      '---\nname: fixit\ndescription: review then fix\n---\n```yaml\nkind: seq\nsteps:\n  - { kind: workflow, name: review, params: { target: "src/" }, as: rev }\n  - { kind: agent, name: worker, task: "Fix: {rev}" }\n```\n',
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics).toEqual([]);
    expect(workflows.map((wf) => wf.name).sort()).toEqual(["fixit", "review"]);
  });

  test("excludes workflows whose flow fails validation", () => {
    writeWorkflow(
      "broken",
      '---\nname: broken\ndescription: d\n---\n```yaml\nkind: agent\nname: a\ntask: "use {nothere}"\n```\n',
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics[0]?.message).toContain("unknown reference {nothere}");
  });

  test("detects cycles across saved workflows", () => {
    writeWorkflow(
      "a",
      "---\nname: a\ndescription: d\n---\n```yaml\nkind: workflow\nname: b\n```\n",
    );
    writeWorkflow(
      "b",
      "---\nname: b\ndescription: d\n---\n```yaml\nkind: workflow\nname: a\n```\n",
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
      "---\nname: solo\ndescription: d\n---\n```yaml\nkind: workflow\nname: ghost\n```\n",
    );
    const { diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics[0]?.message).toContain("unknown workflow 'ghost'");
  });
});

describe("extractFlowBlocks", () => {
  test("only yaml/json fences count", () => {
    const body = "```ts\ncode\n```\n\n```yaml\nkind: agent\n```\n";
    const blocks = extractFlowBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe("yaml");
  });
});
