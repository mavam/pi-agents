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

function writeWorkflow(fileName: string, content: string): string {
  const filePath = path.join(projectDir, ".pi", "workflows", fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const REVIEW = `name: review
description: Multi-lens code review
trigger: when the user asks for a thorough review
display: report
doc: Reviews the target from two lenses.
params:
  - name: target
    required: true
  - depth
flow:
  kind: parallel
  branches:
    bugs: { kind: agent, name: reviewer, task: "Find bugs in {params.target}" }
    style: { kind: agent, name: reviewer, task: "Check style in {params.target}" }
  reduce: { agent: synthesizer, task: "Merge {branches}" }
`;

describe("parseWorkflowFile", () => {
  test("parses a pure YAML workflow", () => {
    const filePath = writeWorkflow("review.yaml", REVIEW);
    const result = parseWorkflowFile(filePath, "project");
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;
    expect(result.name).toBe("review");
    expect(result.description).toBe("Multi-lens code review");
    expect(result.trigger).toContain("thorough review");
    expect(result.display).toBe("report");
    expect(result.params).toEqual([
      {
        name: "target",
        description: undefined,
        required: true,
        default: undefined,
      },
      { name: "depth" },
    ]);
    expect(result.flow.kind).toBe("parallel");
    expect(result.doc).toBe("Reviews the target from two lenses.");
  });

  test("parses a pure JSON workflow", () => {
    const filePath = writeWorkflow(
      "compact.json",
      JSON.stringify({
        name: "compact",
        description: "json form",
        flow: { kind: "agent", name: "a", task: "t" },
      }),
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.name).toBe("compact");
    expect(result.flow).toMatchObject({ kind: "agent", name: "a" });
  });

  test("flat agent form normalizes to a bare agent leaf", () => {
    const filePath = writeWorkflow(
      "bug-hunt.yaml",
      `name: bug-hunt
description: Hunt bugs in a target
params:
  - { name: target, required: true }
agent: reviewer
task: "Review {params.target} strictly for bugs."
model: cheap-model
thinking: low
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

  test("the flat form and the explicit tree yield the same agent node", () => {
    const options = `agent: reviewer
task: t
model: cheap-model
thinking: low
skills: [code-review, gh]
tools: []
cwd: /elsewhere
scope: user
output: json
`;
    const flat = parseWorkflowFile(
      writeWorkflow(
        "flat-full.yaml",
        `name: flat-full\ndescription: d\n${options}`,
      ),
      "project",
    );
    const explicit = parseWorkflowFile(
      writeWorkflow(
        "tree-full.yaml",
        `name: tree-full
description: d
flow:
  kind: agent
  name: reviewer
  task: t
  model: cheap-model
  thinking: low
  skills: [code-review, gh]
  tools: []
  cwd: /elsewhere
  scope: user
  output: json
`,
      ),
      "project",
    );
    if (typeof flat === "string") throw new Error(flat);
    if (typeof explicit === "string") throw new Error(explicit);
    expect(flat.flow).toEqual(explicit.flow);
    // Explicit empty lists survive normalization: [] is not "absent".
    expect(flat.flow).toMatchObject({
      skills: ["code-review", "gh"],
      tools: [],
    });
  });

  test("rejects a flat list key with a scalar value", () => {
    expect(
      parseWorkflowFile(
        writeWorkflow(
          "scalar-skills.yaml",
          "name: scalar-skills\ndescription: d\ntask: t\nskills: code-review\n",
        ),
        "project",
      ),
    ).toContain("Invalid 'skills' (must be an array of strings)");
  });

  test("flat form requires a task", () => {
    const filePath = writeWorkflow(
      "just-agent.yaml",
      "name: just-agent\ndescription: d\nagent: reviewer\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "The flat agent form requires 'task:'",
    );
  });

  test("requires flow: or the flat form", () => {
    const filePath = writeWorkflow(
      "empty.yaml",
      "name: empty\ndescription: d\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "No flow found: add a 'flow:' key",
    );
  });

  test("rejects mixing flow: with the flat form", () => {
    const filePath = writeWorkflow(
      "mixed.yaml",
      "name: mixed\ndescription: d\nagent: reviewer\nflow: { kind: agent, name: reviewer, task: t }\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain("not both");
  });

  test("rejects flat-form keys next to flow:", () => {
    expect(
      parseWorkflowFile(
        writeWorkflow(
          "stray.yaml",
          "name: stray\ndescription: d\ntask: t\nflow: { kind: agent, name: reviewer, task: t }\n",
        ),
        "project",
      ),
    ).toContain("not both");
    expect(
      parseWorkflowFile(
        writeWorkflow(
          "stray-model.yaml",
          "name: stray-model\ndescription: d\nmodel: m\nflow: { kind: agent, name: reviewer, task: t }\n",
        ),
        "project",
      ),
    ).toContain("'model' belongs to the flat agent form");
    // Every flat-only key is gated, not just model/thinking: silently
    // dropping skills would make the sugar and the tree disagree.
    expect(
      parseWorkflowFile(
        writeWorkflow(
          "stray-skills.yaml",
          "name: stray-skills\ndescription: d\nskills: [code-review]\nflow: { kind: agent, name: reviewer, task: t }\n",
        ),
        "project",
      ),
    ).toContain("'skills' belongs to the flat agent form");
  });

  test("task-only flat form yields an anonymous leaf", () => {
    const filePath = writeWorkflow(
      "summarize.yaml",
      `name: summarize
description: Summarize a target
params:
  - { name: target, required: true }
task: "Summarize {params.target}"
model: cheap-model
thinking: low
`,
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.flow).toMatchObject({
      kind: "agent",
      task: "Summarize {params.target}",
      model: "cheap-model",
      thinking: "low",
    });
    expect((result.flow as { name?: string }).name).toBeUndefined();
  });

  test("explicit anonymous leaves are valid in saved flows", () => {
    const filePath = writeWorkflow(
      "anon-flow.yaml",
      `name: anon-flow
description: d
flow:
  kind: parallel
  branches:
    a: { kind: agent, task: "review A" }
    b: { kind: agent, task: "review B" }
  reduce: { task: "merge {branches}" }
`,
    );
    const result = parseWorkflowFile(filePath, "project");
    if (typeof result === "string") throw new Error(result);
    expect(result.flow.kind).toBe("parallel");
  });

  test("rejects non-object files and parse errors", () => {
    expect(
      parseWorkflowFile(writeWorkflow("list.yaml", "- a\n- b\n"), "project"),
    ).toContain("must contain a single YAML/JSON object");
    expect(
      parseWorkflowFile(writeWorkflow("broken.json", "{ not json"), "project"),
    ).toContain("Could not parse json");
  });

  test("rejects unknown keys", () => {
    const filePath = writeWorkflow(
      "bad.yaml",
      "name: bad\ndescription: d\nmodell: x\nflow: { kind: agent, name: a, task: t }\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "Unsupported keys: modell",
    );
  });

  test("rejects invalid names, display paths, and debounce", () => {
    const badName = writeWorkflow(
      "badname.yaml",
      "name: 'bad name'\ndescription: d\nflow: { kind: agent, name: a, task: t }\n",
    );
    expect(parseWorkflowFile(badName, "project")).toContain("invalid 'name'");
    const badDisplay = writeWorkflow(
      "baddisplay.yaml",
      "name: baddisplay\ndescription: d\ndisplay: 'report title'\nflow: { kind: agent, name: a, task: t }\n",
    );
    expect(parseWorkflowFile(badDisplay, "project")).toContain(
      "Invalid 'display'",
    );
    const badDebounce = writeWorkflow(
      "baddeb.yaml",
      "name: baddeb\ndescription: d\ndebounce: -5\nflow: { kind: agent, name: a, task: t }\n",
    );
    expect(parseWorkflowFile(badDebounce, "project")).toContain(
      "Invalid 'debounce'",
    );
  });

  test("structurally invalid flow is reported with node paths", () => {
    const filePath = writeWorkflow(
      "badflow.yaml",
      "name: badflow\ndescription: d\nflow: { kind: spawn, agent: a }\n",
    );
    expect(parseWorkflowFile(filePath, "project")).toContain(
      "unknown kind 'spawn'",
    );
  });

  test("hook workflows get the implicit event param", () => {
    const filePath = writeWorkflow(
      "hooked.yaml",
      `name: hooked
description: d
on: [turn_end]
debounce: 60000
flow: { kind: agent, name: a, task: "look at {params.event}" }
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
    writeWorkflow("review.yaml", REVIEW);
    writeWorkflow(
      "fixit.yaml",
      `name: fixit
description: review then fix
flow:
  kind: sequence
  steps:
    - { kind: workflow, name: review, params: { target: "src/" }, as: rev }
    - { kind: agent, name: worker, task: "Fix: {rev}" }
`,
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics).toEqual([]);
    expect(workflows.map((wf) => wf.name).sort()).toEqual(["fixit", "review"]);
  });

  test("stale .md workflow files get a migration diagnostic", () => {
    writeWorkflow("old.md", "---\nname: old\ndescription: d\n---\n");
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics[0]?.message).toContain("rename to .yaml");
  });

  test("non-workflow extensions are ignored", () => {
    writeWorkflow("notes.txt", "not a workflow");
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test("excludes workflows whose flow fails validation", () => {
    writeWorkflow(
      "broken.yaml",
      'name: broken\ndescription: d\nflow: { kind: agent, name: a, task: "use {nothere}" }\n',
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics[0]?.message).toContain("unknown reference {nothere}");
  });

  test("detects cycles across saved workflows", () => {
    writeWorkflow(
      "a.yaml",
      "name: a\ndescription: d\nflow: { kind: workflow, name: b }\n",
    );
    writeWorkflow(
      "b.yaml",
      "name: b\ndescription: d\nflow: { kind: workflow, name: a }\n",
    );
    const { workflows, diagnostics } = discoverWorkflows(projectDir, "project");
    expect(workflows).toEqual([]);
    expect(diagnostics.map((d) => d.message).join("\n")).toContain(
      "workflow cycle",
    );
  });

  test("unknown references to other workflows are diagnosed", () => {
    writeWorkflow(
      "solo.yaml",
      "name: solo\ndescription: d\nflow: { kind: workflow, name: ghost }\n",
    );
    const { diagnostics } = discoverWorkflows(projectDir, "project");
    expect(diagnostics[0]?.message).toContain("unknown workflow 'ghost'");
  });
});
