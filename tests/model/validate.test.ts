import { describe, expect, test } from "bun:test";
import type { FlowNode, WorkflowLike } from "../../src/model/ast.js";
import {
  collectAgentNames,
  FlowValidationError,
  validateFlow,
} from "../../src/model/validate.js";

const agent = (
  name: string,
  task: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "agent",
  name,
  task,
  ...extra,
});
const seq = (...steps: unknown[]) => ({ kind: "seq", steps });

/** Validate and return all issue strings, or [] when valid. */
function issuesOf(
  raw: unknown,
  options?: Parameters<typeof validateFlow>[1],
): string[] {
  try {
    validateFlow(raw, options);
    return [];
  } catch (error) {
    if (error instanceof FlowValidationError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
}

function expectIssue(
  raw: unknown,
  substring: string,
  options?: Parameters<typeof validateFlow>[1],
): void {
  const issues = issuesOf(raw, options);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues.join("\n")).toContain(substring);
}

function expectValid(
  raw: unknown,
  options?: Parameters<typeof validateFlow>[1],
): void {
  expect(issuesOf(raw, options)).toEqual([]);
}

describe("structural validation", () => {
  test("a bare agent leaf is a valid flow", () => {
    expectValid(agent("scout", "look around"));
  });

  test("non-object flow", () => {
    expectIssue("nope", "$: expected a flow node object, got string");
  });

  test("missing kind", () => {
    expectIssue({}, "missing 'kind'");
  });

  test("unknown kind", () => {
    expectIssue({ kind: "spawn" }, "unknown kind 'spawn'");
  });

  test("unknown key names the offender and the allowed set", () => {
    expectIssue(agent("a", "t", { model: "x" }), "unknown key 'model'");
  });

  test("agent requires name and task", () => {
    expectIssue({ kind: "agent" }, "'name' must be a non-empty string");
    expectIssue(
      { kind: "agent", name: "a" },
      "'task' must be a non-empty string",
    );
  });

  test("agent output and scope are enums", () => {
    expectIssue(
      agent("a", "t", { output: "yaml" }),
      "'output' must be one of: text, json",
    );
    expectIssue(
      agent("a", "t", { scope: "global" }),
      "'scope' must be one of: user, project, both",
    );
  });

  test("seq requires non-empty steps", () => {
    expectIssue(
      { kind: "seq", steps: [] },
      "'steps' must be a non-empty array",
    );
  });

  test("nested errors carry node paths", () => {
    expectIssue(seq(agent("a", "t"), { kind: "agent" }), "$.steps[1]: 'name'");
  });

  test("par requires branches", () => {
    expectIssue({ kind: "par", branches: {} }, "at least one branch");
  });

  test("par branch keys are restricted", () => {
    expectIssue(
      { kind: "par", branches: { "bad key!": agent("a", "t") } },
      "branch key 'bad key!'",
    );
  });

  test("par mode validation", () => {
    const branches = { a: agent("x", "t"), b: agent("y", "t") };
    expectValid({ kind: "par", branches, mode: "any" });
    expectValid({ kind: "par", branches, mode: { quorum: 2 } });
    expectIssue(
      { kind: "par", branches, mode: "race" },
      `'mode' must be "all", "any", or {quorum: n}`,
    );
    expectIssue(
      { kind: "par", branches, mode: { quorum: 3 } },
      "exceeds the number of branches",
    );
    expectIssue(
      { kind: "par", branches, mode: { quorum: 0 } },
      "'mode.quorum' must be an integer >= 1",
    );
  });

  test("par onError and concurrency", () => {
    const branches = { a: agent("x", "t") };
    expectIssue(
      { kind: "par", branches, onError: "ignore" },
      "'onError' must be one of: fail, collect",
    );
    expectIssue(
      { kind: "par", branches, concurrency: 0 },
      "'concurrency' must be an integer >= 1",
    );
  });

  test("reduce requires agent and task", () => {
    expectIssue(
      { kind: "par", branches: { a: agent("x", "t") }, reduce: { agent: "r" } },
      "$.reduce: 'task' must be a non-empty string",
    );
  });

  test("map over must be a single reference", () => {
    expectIssue(
      seq(agent("s", "t", { as: "files" }), {
        kind: "map",
        over: "files",
        body: agent("r", "review {item}"),
      }),
      "'over' must be exactly one reference",
    );
    expectIssue(
      seq(agent("s", "t", { as: "files" }), {
        kind: "map",
        over: "see {files}",
        body: agent("r", "review {item}"),
      }),
      "'over' must be exactly one reference",
    );
  });

  test("loop requires max", () => {
    expectIssue({ kind: "loop", body: agent("a", "t") }, "'max' is required");
    expectIssue(
      { kind: "loop", body: agent("a", "t"), max: 0 },
      "'max' must be an integer >= 1",
    );
  });

  test("workflow ref rejects derived fields", () => {
    expectIssue(
      { kind: "workflow", name: "w", body: agent("a", "t") },
      "'body' is derived during expansion",
    );
  });

  test("as must be a valid, non-reserved identifier", () => {
    expectIssue(
      seq(agent("a", "t", { as: "1bad" }), agent("b", "t")),
      "'as' must match",
    );
    expectIssue(
      seq(agent("a", "t", { as: "previous" }), agent("b", "t")),
      "reserved name 'previous'",
    );
  });

  test("predicate validation", () => {
    const loop = (until: unknown) => ({
      kind: "loop",
      body: agent("a", "t"),
      max: 2,
      until,
    });
    expectValid(loop({ eq: ["done", true] }));
    expectValid(
      loop({ and: [{ not: { empty: "findings" } }, { gt: ["score", 3] }] }),
    );
    expectIssue(loop({ eq: ["done", true], ne: ["x", 1] }), "exactly one of");
    expectIssue(loop({ matches: "done" }), "exactly one of");
    expectIssue(loop({ eq: ["done"] }), "'eq' must be a [path, value] pair");
    expectIssue(
      loop({ eq: ["done", { obj: true }] }),
      "'eq' value must be a string, number, boolean, or null",
    );
    expectIssue(
      loop({ gt: ["score", "high"] }),
      "'gt' must be a [path, number] pair",
    );
    expectIssue(loop({ exists: "bad path!" }), "path must be a dot-path");
    expectIssue(loop({ and: [] }), "'and' must be a non-empty array");
    expectIssue(
      loop({ not: { bogus: 1 } }),
      "$.until.not: a predicate must have exactly one of",
    );
  });
});

describe("binding scope", () => {
  test("as binds for later steps, arbitrarily deep", () => {
    expectValid(
      seq(agent("scout", "map the code", { as: "map" }), {
        kind: "par",
        branches: {
          bugs: agent("reviewer", "find bugs in {map}"),
          style: seq(agent("reviewer", "style of {map.summary}")),
        },
      }),
    );
  });

  test("forward references are errors", () => {
    expectIssue(
      seq(agent("a", "use {later}"), agent("b", "t", { as: "later" })),
      "unknown reference {later}",
    );
  });

  test("unknown reference lists bindings in scope", () => {
    expectIssue(
      seq(agent("a", "t", { as: "map" }), agent("b", "use {mpa}")),
      "unknown reference {mpa} (bindings in scope: map)",
    );
  });

  test("as is only legal on seq steps", () => {
    expectIssue(
      agent("a", "t", { as: "x" }),
      "$: 'as' is only legal on direct steps of a seq",
    );
    expectIssue(
      { kind: "par", branches: { a: agent("x", "t", { as: "y" }) } },
      "$.branches.a: 'as' is only legal",
    );
    expectIssue(
      seq(agent("s", "t", { as: "files" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}", { as: "y" }),
      }),
      "$.steps[1].body: 'as' is only legal",
    );
    expectIssue(
      { kind: "loop", body: agent("a", "t", { as: "y" }), max: 2 },
      "$.body: 'as' is only legal",
    );
  });

  test("duplicate bindings in one seq", () => {
    expectIssue(
      seq(
        agent("a", "t", { as: "x" }),
        agent("b", "t", { as: "x" }),
        agent("c", "use {x}"),
      ),
      "duplicate binding 'x'",
    );
  });

  test("shadowing an outer binding", () => {
    expectIssue(
      seq(
        agent("a", "t", { as: "x" }),
        seq(agent("b", "t", { as: "x" }), agent("c", "use {x}")),
      ),
      "binding 'x' shadows an outer binding",
    );
  });

  test("previous requires a preceding step in the nearest seq", () => {
    expectValid(seq(agent("a", "t"), agent("b", "continue from {previous}")));
    expectIssue(agent("a", "use {previous}"), "{previous} is not available");
    expectIssue(
      seq(agent("a", "use {previous}"), agent("b", "t")),
      "{previous} is not available",
    );
  });

  test("previous resets inside a nested seq's first step", () => {
    expectIssue(
      seq(agent("a", "t"), seq(agent("b", "use {previous}"), agent("c", "t"))),
      "$.steps[1].steps[0].task: {previous} is not available",
    );
  });

  test("previous propagates into par branches of a later step", () => {
    expectValid(
      seq(agent("a", "t"), {
        kind: "par",
        branches: { x: agent("b", "work on {previous}") },
      }),
    );
  });

  test("item and index only inside map bodies", () => {
    expectIssue(
      agent("a", "use {item}"),
      "{item} is only available inside a map body",
    );
    expectIssue(
      agent("a", "use {index}"),
      "{index} is only available inside a map body",
    );
    expectValid(
      seq(agent("s", "list files", { as: "files" }), {
        kind: "map",
        over: "{files}",
        body: seq(
          agent("r", "review {item} (#{index})"),
          agent("f", "fix {previous}"),
        ),
      }),
    );
  });

  test("iteration and last only inside loop bodies", () => {
    expectIssue(
      agent("a", "use {last}"),
      "{last} is only available inside a loop body",
    );
    expectValid({
      kind: "loop",
      body: agent("a", "iteration {iteration}, refine {last}"),
      max: 3,
    });
  });

  test("map over is scope-checked", () => {
    expectIssue(
      { kind: "map", over: "{files}", body: agent("r", "review {item}") },
      "$.over: unknown reference {files}",
    );
  });

  test("branches and items are reduce-only", () => {
    expectIssue(
      agent("a", "use {branches}"),
      "{branches} is only available in a par reduce task",
    );
    expectIssue(
      agent("a", "use {items}"),
      "{items} is only available in a map reduce task",
    );
    expectValid({
      kind: "par",
      branches: { a: agent("x", "t") },
      reduce: { agent: "syn", task: "merge {branches}" },
    });
    expectIssue(
      {
        kind: "par",
        branches: { a: agent("x", "t") },
        reduce: { agent: "syn", task: "merge {items}" },
      },
      "$.reduce.task: {items} is only available in a map reduce task",
    );
    expectValid(
      seq(agent("s", "t", { as: "files" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
        reduce: { agent: "syn", task: "merge {items}" },
      }),
    );
  });

  test("reduce tasks see outer bindings but not the body scope", () => {
    expectValid(
      seq(agent("s", "t", { as: "goal" }), {
        kind: "map",
        over: "{goal.files}",
        body: agent("r", "review {item}"),
        reduce: { agent: "syn", task: "merge {items} against {goal}" },
      }),
    );
    expectIssue(
      seq(agent("s", "t", { as: "files" }), {
        kind: "map",
        over: "{files}",
        body: agent("r", "review {item}"),
        reduce: { agent: "syn", task: "merge {item}" },
      }),
      "$.steps[1].reduce.task: {item} is only available inside a map body",
    );
  });

  test("params must be declared", () => {
    expectValid(agent("a", "review {params.target}"), {
      params: [{ name: "target" }],
    });
    expectIssue(
      agent("a", "review {params.target}"),
      "unknown parameter {params.target}",
    );
    expectIssue(
      agent("a", "review {params}"),
      "{params} must name a parameter",
      { params: [{ name: "target" }] },
    );
  });
});

describe("workflow expansion", () => {
  const reviewDef: WorkflowLike = {
    name: "review",
    params: [{ name: "target", required: true }],
    flow: {
      kind: "par",
      branches: {
        bugs: {
          kind: "agent",
          name: "reviewer",
          task: "bugs in {params.target}",
        },
        style: {
          kind: "agent",
          name: "reviewer",
          task: "style in {params.target}",
        },
      },
      reduce: { agent: "synthesizer", task: "merge {branches}" },
    } as FlowNode,
  };

  const resolver = (defs: WorkflowLike[]) => (name: string) =>
    defs.find((def) => def.name === name);

  test("refs inline and validate end to end", () => {
    const flow = validateFlow(
      seq(
        {
          kind: "workflow",
          name: "review",
          params: { target: "src/" },
          as: "rev",
        },
        agent("worker", "fix {rev}"),
      ),
      { resolveWorkflow: resolver([reviewDef]) },
    );
    const ref = (flow as { steps: FlowNode[] }).steps[0];
    expect(ref).toMatchObject({ kind: "workflow", name: "review" });
    expect((ref as { body?: FlowNode }).body).toMatchObject({ kind: "par" });
  });

  test("refs require a resolver", () => {
    expectIssue(
      { kind: "workflow", name: "review" },
      "no saved-workflow resolver",
    );
  });

  test("unknown workflow", () => {
    expectIssue({ kind: "workflow", name: "nope" }, "unknown workflow 'nope'", {
      resolveWorkflow: resolver([reviewDef]),
    });
  });

  test("missing required param", () => {
    expectIssue(
      { kind: "workflow", name: "review" },
      "requires parameter 'target'",
      { resolveWorkflow: resolver([reviewDef]) },
    );
  });

  test("required param satisfied by a default", () => {
    const withDefault: WorkflowLike = {
      ...reviewDef,
      name: "review2",
      params: [{ name: "target", required: true, default: "." }],
    };
    expectValid(
      { kind: "workflow", name: "review2" },
      { resolveWorkflow: resolver([withDefault]) },
    );
  });

  test("unknown param key", () => {
    expectIssue(
      {
        kind: "workflow",
        name: "review",
        params: { target: "src/", extra: "x" },
      },
      "no parameter 'extra' (declared: target)",
      { resolveWorkflow: resolver([reviewDef]) },
    );
  });

  test("param values interpolate in the caller's scope", () => {
    expectValid(
      seq(agent("scout", "t", { as: "map" }), {
        kind: "workflow",
        name: "review",
        params: { target: "{map.hotspots}" },
      }),
      { resolveWorkflow: resolver([reviewDef]) },
    );
    expectIssue(
      { kind: "workflow", name: "review", params: { target: "{nothere}" } },
      "$.params.target: unknown reference {nothere}",
      { resolveWorkflow: resolver([reviewDef]) },
    );
  });

  test("inlined bodies are opaque to caller bindings", () => {
    const leaky: WorkflowLike = {
      name: "leaky",
      params: [],
      flow: { kind: "agent", name: "a", task: "use {map}" } as FlowNode,
    };
    expectIssue(
      seq(agent("scout", "t", { as: "map" }), {
        kind: "workflow",
        name: "leaky",
      }),
      "$.steps[1].body.task: unknown reference {map}",
      { resolveWorkflow: resolver([leaky]) },
    );
  });

  test("cycles are rejected with the chain", () => {
    const a: WorkflowLike = {
      name: "a",
      params: [],
      flow: { kind: "workflow", name: "b" } as FlowNode,
    };
    const b: WorkflowLike = {
      name: "b",
      params: [],
      flow: { kind: "workflow", name: "a" } as FlowNode,
    };
    expectIssue({ kind: "workflow", name: "a" }, "workflow cycle: a → b → a", {
      resolveWorkflow: resolver([a, b]),
    });
  });

  test("self-reference detected via selfName", () => {
    const self: WorkflowLike = {
      name: "self",
      params: [],
      flow: { kind: "agent", name: "a", task: "t" } as FlowNode,
    };
    expectIssue(
      { kind: "workflow", name: "self" },
      "workflow cycle: self → self",
      { resolveWorkflow: resolver([self]), selfName: "self" },
    );
  });

  test("nested refs expand transitively", () => {
    const outer: WorkflowLike = {
      name: "outer",
      params: [],
      flow: seq(
        { kind: "workflow", name: "review", params: { target: "src/" } },
        agent("worker", "apply {previous}"),
      ) as unknown as FlowNode,
    };
    expectValid(
      { kind: "workflow", name: "outer" },
      { resolveWorkflow: resolver([outer, reviewDef]) },
    );
  });
});

describe("collectAgentNames", () => {
  test("collects leaves, reducers, and inlined workflow agents", () => {
    const flow = validateFlow(
      seq(
        agent("scout", "t", { as: "files" }),
        {
          kind: "map",
          over: "{files}",
          body: agent("reviewer", "review {item}"),
          reduce: { agent: "synthesizer", task: "merge {items}" },
        },
        {
          kind: "workflow",
          name: "review",
          params: { target: "src/" },
        },
      ),
      {
        resolveWorkflow: (name) =>
          name === "review"
            ? {
                name: "review",
                params: [{ name: "target" }],
                flow: {
                  kind: "agent",
                  name: "inner-agent",
                  task: "use {params.target}",
                } as FlowNode,
              }
            : undefined,
      },
    );
    expect([...collectAgentNames(flow)].sort()).toEqual([
      "inner-agent",
      "reviewer",
      "scout",
      "synthesizer",
    ]);
  });
});
