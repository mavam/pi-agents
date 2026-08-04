import { describe, expect, test } from "bun:test";
import type { WorkflowLike } from "../../src/model/ast.js";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { rebuildRunState } from "../../src/run/state.js";
import { renderFlowTree, renderRunTree } from "../../src/ui/tree.js";

describe("renderFlowTree", () => {
  test("the review par reads as a compact icon tree", () => {
    const flow = validateFlow(
      {
        kind: "parallel",
        branches: {
          bugs: {
            kind: "agent",
            name: "reviewer",
            task: "Review {params.target} strictly for correctness bugs: logic errors, edge cases, races, resource leaks.",
          },
          clarity: {
            kind: "agent",
            name: "reviewer",
            task: "Review {params.target} for readability, duplication, and simplification opportunities.",
          },
        },
        reduce: {
          agent: "worker",
          task: "Merge these code review findings into one prioritized list:\n\n{branches}",
        },
      },
      { params: [{ name: "target" }] },
    );
    const tree = renderFlowTree(flow);
    expect(tree).toBe(
      [
        "⑃ parallel (all)",
        "├─ bugs → ✦ reviewer · Review {params.target} strictly for correctness bugs: lo…",
        "├─ clarity → ✦ reviewer · Review {params.target} for readability, duplication, and…",
        "└─ ⑂ reduce → worker · Merge these code review findings into one prioritized li…",
      ].join("\n"),
    );
  });

  test("seq is transparent; bindings, map, and loop show their shape", () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "List files",
          output: "json",
          as: "files",
        },
        {
          kind: "map",
          over: "{files}",
          concurrency: 4,
          body: { kind: "agent", name: "reviewer", task: "Review {item}" },
          reduce: { agent: "syn", task: "Merge {items}" },
        },
        {
          kind: "loop",
          max: 3,
          until: { eq: ["done", true] },
          body: { kind: "agent", name: "fixer", task: "Fix {last}" },
        },
      ],
    });
    const tree = renderFlowTree(flow);
    const lines = tree.split("\n");
    // Seq steps sit flush left, not nested under a seq node.
    expect(lines[0]).toBe("✦ scout → {files} · List files");
    expect(lines[1]).toBe("⇶ map {files} (×4)");
    expect(tree).toContain("└─ ⑂ reduce → syn · Merge {items}");
    expect(tree).toContain("↺ loop ≤3 until done == true");
    expect(tree).toContain("└─ ✦ fixer · Fix {last}");
    expect(tree).not.toContain("≡");
  });

  test("while renders its pre-checked condition and carried value", () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "reviewer",
          task: "Review",
          output: "json",
          as: "review",
        },
        {
          kind: "while",
          on: "{review}",
          condition: { eq: ["outcome", "changes_required"] },
          max: 3,
          body: {
            kind: "agent",
            name: "fixer",
            task: "Fix round {iteration} from {current}",
            output: "json",
          },
          as: "result",
        },
      ],
    });
    expect(renderFlowTree(flow)).toBe(
      [
        "✦ reviewer → {review} · Review",
        '↺ while outcome == "changes_required" on {review} ≤3 → {result}',
        "└─ ✦ fixer · Fix round {iteration} from {current}",
      ].join("\n"),
    );
  });

  test("anonymous agents and reducers render as ad-hoc", () => {
    expect(
      renderFlowTree(
        validateFlow({ kind: "agent", task: "Create a worktree" }),
      ),
    ).toBe("✦ ad-hoc · Create a worktree");
    const flow = validateFlow({
      kind: "parallel",
      branches: {
        a: { kind: "agent", task: "Review A" },
        b: { kind: "agent", name: "reviewer", task: "Review B" },
      },
      reduce: { task: "Merge {branches}" },
    });
    const tree = renderFlowTree(flow);
    expect(tree).toContain("├─ a → ✦ ad-hoc · Review A");
    expect(tree).toContain("├─ b → ✦ reviewer · Review B");
    expect(tree).toContain("└─ ⑂ reduce → ad-hoc · Merge {branches}");
  });

  test("switch arms show predicates; single-node arms collapse", () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "gate",
          task: "inspect",
          output: "json",
          as: "gate",
        },
        {
          kind: "switch",
          on: "{gate}",
          cases: [
            {
              when: { eq: ["status", "approved"] },
              then: { kind: "agent", name: "shipper", task: "ship it" },
            },
            {
              when: { exists: "findings" },
              then: {
                kind: "sequence",
                steps: [
                  { kind: "agent", name: "fixer", task: "fix" },
                  { kind: "agent", name: "checker", task: "recheck" },
                ],
              },
            },
          ],
          else: {
            kind: "value",
            value: { outcome: "{gate.outcome}" },
            label: "outcome",
          },
          as: "result",
        },
      ],
    });
    const tree = renderFlowTree(flow);
    expect(tree).toBe(
      [
        "✦ gate → {gate} · inspect",
        "⎇ switch {gate} → {result}",
        '├─ when status == "approved" → ✦ shipper · ship it',
        "├─ when exists(findings):",
        "│  ├─ ✦ fixer · fix",
        "│  └─ ✦ checker · recheck",
        '└─ else → ≔ outcome · {"outcome":"{gate.outcome}"}',
      ].join("\n"),
    );
  });

  test("multi-step branches group under their key; workflow refs show params", () => {
    const def: WorkflowLike = {
      name: "inner",
      params: [{ name: "x" }],
      flow: { kind: "agent", name: "a", task: "use {params.x}" },
    };
    const flow = validateFlow(
      {
        kind: "parallel",
        branches: {
          quick: { kind: "agent", name: "a", task: "t" },
          slow: {
            kind: "sequence",
            steps: [
              { kind: "agent", name: "prep", task: "prepare" },
              { kind: "workflow", name: "inner", params: { x: "42" } },
            ],
          },
        },
      },
      { resolveWorkflow: () => def },
    );
    const tree = renderFlowTree(flow);
    expect(tree).toContain("├─ quick → ✦ a · t");
    expect(tree).toContain("└─ slow:");
    expect(tree).toContain("   ├─ ✦ prep · prepare");
    expect(tree).toContain("   └─ ❖ inner (x: 42)");
    // The inlined body nests under the ref.
    expect(tree).toContain("      └─ ✦ a · use {params.x}");
  });
});

describe("renderFlowTree coloring", () => {
  test("dataflow-first: refs accent, prose/skeleton dim, glyphs muted", () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "List files",
          output: "json",
          as: "files",
        },
        {
          kind: "map",
          over: "{files}",
          body: { kind: "agent", name: "reviewer", task: "Review {item}" },
        },
      ],
    });
    const mark = (color: string, text: string) =>
      `<${color}>${text}</${color}>`;
    const tree = renderFlowTree(flow, mark);
    // Bindings and references light up in accent.
    expect(tree).toContain("<accent>{files}</accent>");
    expect(tree).toContain("<accent>{item}</accent>");
    expect(tree).toContain("scout<dim> → </dim><accent>{files}</accent>");
    // Prose and connectors are dim; glyphs muted; names plain.
    expect(tree).toContain("<dim>List files</dim>");
    expect(tree).toContain("<dim>└─ </dim>");
    expect(tree).toContain("<muted>✦</muted>");
    expect(tree).toContain("<muted>⇶</muted> map <accent>{files}</accent>");
    // Default rendering stays byte-identical (no color markers).
    expect(renderFlowTree(flow)).not.toContain("<");
  });
});

describe("renderRunTree", () => {
  test("overlays status icons and aggregates map items", async () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "scout",
          task: "list",
          output: "json",
          as: "files",
        },
        {
          kind: "map",
          over: "{files}",
          body: { kind: "agent", name: "reviewer", task: "review {item}" },
        },
      ],
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r1",
      flow,
      runAgent: async (call) =>
        call.agent === "scout" ? { text: '["a","b","c"]' } : { text: "ok" },
      emit: (event) => events.push(event),
    });
    const run = rebuildRunState(events).runs.get("r1");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("● ✦ scout → {files} · list");
    // Three map items aggregate on the body line.
    expect(tree).toContain("└─ ● ✦ reviewer · review {item} [3/3]");
    // Status icons join the kind glyphs, so structure stays readable.
    expect(tree).toContain("● ⇶ map {files}");
  });

  test("iteration rows show rounds, effective caps, and zero iterations", async () => {
    const loop = validateFlow({
      kind: "loop",
      max: 6,
      until: { eq: ["done", true] },
      body: {
        kind: "agent",
        name: "worker",
        task: "round {iteration}",
        output: "json",
      },
    });
    const loopEvents: RunEvent[] = [];
    await executeFlow({
      runId: "loop-progress",
      flow: loop,
      runAgent: async (call) => ({
        text: call.task === "round 0" ? '{"done":false}' : '{"done":true}',
      }),
      budgets: { maxIterations: 2 },
      emit: (event) => loopEvents.push(event),
    });
    const loopRun = rebuildRunState(loopEvents).runs.get("loop-progress");
    if (!loopRun) throw new Error("missing loop run");
    expect(renderRunTree(loopRun)).toContain(
      "● ↺ loop ≤6 until done == true [#2/2]",
    );

    const whileFlow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "value", value: { continue: false }, as: "state" },
        {
          kind: "while",
          on: "{state}",
          condition: { eq: ["continue", true] },
          max: 4,
          body: { kind: "agent", name: "worker", task: "work" },
        },
      ],
    });
    const whileEvents: RunEvent[] = [];
    await executeFlow({
      runId: "while-progress",
      flow: whileFlow,
      runAgent: async () => ({ text: "unused" }),
      emit: (event) => whileEvents.push(event),
    });
    const whileRun = rebuildRunState(whileEvents).runs.get("while-progress");
    if (!whileRun) throw new Error("missing while run");
    expect(renderRunTree(whileRun)).toContain(
      "● ↺ while continue == true on {state} ≤4 [#0/4]",
    );
  });

  test("the executed switch arm completes; the others are skipped", async () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        {
          kind: "agent",
          name: "gate",
          task: "inspect",
          output: "json",
          as: "gate",
        },
        {
          kind: "switch",
          on: "{gate}",
          cases: [
            {
              when: { eq: ["status", "approved"] },
              then: { kind: "agent", name: "shipper", task: "ship" },
            },
            {
              when: { eq: ["status", "rejected"] },
              then: {
                kind: "sequence",
                steps: [
                  { kind: "agent", name: "auditor", task: "audit" },
                  { kind: "agent", name: "notifier", task: "notify" },
                ],
              },
            },
          ],
          else: { kind: "agent", name: "reporter", task: "report" },
        },
      ],
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r5",
      flow,
      runAgent: async (call) =>
        call.agent === "gate"
          ? { text: '{"status": "approved"}' }
          : { text: "shipped" },
      emit: (event) => events.push(event),
    });
    const chosenStarted = events.findIndex(
      (event) =>
        event.type === "node_started" &&
        event.instance === "$.steps[1].cases[0].then",
    );
    const live = rebuildRunState(events.slice(0, chosenStarted + 1)).runs.get(
      "r5",
    );
    if (!live) throw new Error("missing live run");
    const liveTree = renderRunTree(live);
    expect(liveTree).toContain(
      'when status == "approved" → ◉ ✦ shipper · ship',
    );
    expect(liveTree).toContain("else → ⊖ ✦ reporter · report");
    expect(liveTree).toContain("⊖ ✦ auditor · audit");
    expect(liveTree).toContain("⊖ ✦ notifier · notify");

    const run = rebuildRunState(events).runs.get("r5");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("● ⎇ switch {gate}");
    expect(tree).toContain('when status == "approved" → ● ✦ shipper · ship');
    expect(tree).toContain("else → ⊖ ✦ reporter · report");
    const mark = (color: string, text: string) =>
      `<${color}>${text}</${color}>`;
    expect(renderRunTree(run, mark)).toContain("<muted>✦</muted> reporter");
  });

  test("dynamic switch arms wait until all choices are final", async () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "value", value: ["approved", "approved"], as: "seeds" },
        {
          kind: "map",
          over: "{seeds}",
          concurrency: 1,
          body: {
            kind: "switch",
            on: "{item}",
            cases: [
              {
                when: { eq: ["", "approved"] },
                then: { kind: "agent", name: "shipper", task: "ship" },
              },
            ],
            else: { kind: "agent", name: "reporter", task: "report" },
          },
        },
      ],
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "dynamic-switch",
      flow,
      runAgent: async () => ({ text: "ok" }),
      emit: (event) => events.push(event),
    });
    const firstChoice = events.findIndex(
      (event) =>
        event.type === "node_started" &&
        event.instance === "$.steps[1].body@0.cases[0].then",
    );
    const live = rebuildRunState(events.slice(0, firstChoice + 1)).runs.get(
      "dynamic-switch",
    );
    if (!live) throw new Error("missing live dynamic run");
    expect(renderRunTree(live)).toContain("else → ○ ✦ reporter · report");

    const completed = rebuildRunState(events).runs.get("dynamic-switch");
    if (!completed) throw new Error("missing completed dynamic run");
    expect(renderRunTree(completed)).toContain("else → ⊖ ✦ reporter · report");
  });

  test("anonymous runs replay from persisted events and render as ad-hoc", async () => {
    const flow = validateFlow({
      kind: "sequence",
      steps: [
        { kind: "agent", task: "scout", as: "map" },
        { kind: "agent", name: "worker", task: "use {map}" },
      ],
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r3",
      flow,
      runAgent: async () => ({ text: "ok" }),
      emit: (event) => events.push(event),
    });
    // Round-trip through JSON exactly like the sidecar persistence does.
    const replayed = events.map(
      (event) => JSON.parse(JSON.stringify(event)) as RunEvent,
    );
    const run = rebuildRunState(replayed).runs.get("r3");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("● ✦ ad-hoc → {map} · scout");
    expect(tree).toContain("● ✦ worker · use {map}");
    const nodes = [...run.nodes.values()].filter(
      (node) => node.kind === "agent",
    );
    expect(nodes.some((node) => node.agent === undefined)).toBe(true);
    expect(nodes.some((node) => node.agent === "worker")).toBe(true);
  });

  test("status icons are colored by outcome", async () => {
    const flow = validateFlow({
      kind: "parallel",
      branches: {
        good: { kind: "agent", name: "a", task: "ok" },
        bad: { kind: "agent", name: "b", task: "boom" },
      },
    });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r4",
      flow,
      runAgent: async (call) => {
        if (call.agent === "b") throw new Error("kaput");
        return { text: "ok" };
      },
      emit: (event) => events.push(event),
    });
    const run = rebuildRunState(events).runs.get("r4");
    if (!run) throw new Error("missing run");
    const mark = (color: string, text: string) =>
      `<${color}>${text}</${color}>`;
    const tree = renderRunTree(run, mark);
    // Colored contexts keep the kind glyph and encode status in its tint.
    expect(tree).toContain("<success>✦</success> a");
    expect(tree).toContain("<error>✦</error> b");
    expect(tree).not.toContain("●");
    // Plain contexts pair a status icon with the kind glyph instead.
    const plain = renderRunTree(run);
    expect(plain).not.toContain("<");
    expect(plain).toContain("● ✦ a");
    expect(plain).toContain("✗ ✦ b");
  });

  test("failures surface inline with ✗", async () => {
    const flow = validateFlow({ kind: "agent", name: "a", task: "boom" });
    const events: RunEvent[] = [];
    await executeFlow({
      runId: "r2",
      flow,
      runAgent: async () => {
        throw new Error("kaput");
      },
      emit: (event) => events.push(event),
    });
    const run = rebuildRunState(events).runs.get("r2");
    if (!run) throw new Error("missing run");
    const tree = renderRunTree(run);
    expect(tree).toContain("✗ ✦ a · boom — kaput");
  });
});
