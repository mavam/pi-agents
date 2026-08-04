import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import type { FlowNode, WorkflowLike } from "../../src/model/ast.js";
import {
  collectAgentNames,
  collectInvocations,
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
const seq = (...steps: unknown[]) => ({ kind: "sequence", steps });

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
    expectIssue(agent("a", "t", { retries: 3 }), "unknown key 'retries'");
  });

  test("agent requires a task; name is optional", () => {
    expectIssue({ kind: "agent" }, "'task' must be a non-empty string");
    expectIssue(
      { kind: "agent", name: "a" },
      "'task' must be a non-empty string",
    );
    expectValid({ kind: "agent", task: "do the thing" });
  });

  test("an anonymous agent with overrides is a valid flow", () => {
    expectValid({
      kind: "agent",
      task: "do the thing",
      model: "some-model",
      thinking: "low",
    });
  });

  test("a present name must be non-empty", () => {
    expectIssue(
      { kind: "agent", name: "", task: "t" },
      "'name' must be a non-empty string when present",
    );
  });

  test("agent nodes accept model and thinking overrides", () => {
    expectValid(agent("a", "t", { model: "some-model", thinking: "low" }));
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
      { kind: "sequence", steps: [] },
      "'steps' must be a non-empty array",
    );
  });

  test("nested errors carry node paths", () => {
    expectIssue(seq(agent("a", "t"), { kind: "agent" }), "$.steps[1]: 'task'");
  });

  test("par requires branches", () => {
    expectIssue({ kind: "parallel", branches: {} }, "at least one branch");
  });

  test("par branch keys are restricted", () => {
    expectIssue(
      { kind: "parallel", branches: { "bad key!": agent("a", "t") } },
      "branch key 'bad key!'",
    );
  });

  test("par mode validation", () => {
    const branches = { a: agent("x", "t"), b: agent("y", "t") };
    expectValid({ kind: "parallel", branches, mode: "any" });
    expectValid({ kind: "parallel", branches, mode: { quorum: 2 } });
    expectIssue(
      { kind: "parallel", branches, mode: "race" },
      `'mode' must be "all", "any", or {quorum: n}`,
    );
    expectIssue(
      { kind: "parallel", branches, mode: { quorum: 3 } },
      "exceeds the number of branches",
    );
    expectIssue(
      { kind: "parallel", branches, mode: { quorum: 0 } },
      "'mode.quorum' must be an integer >= 1",
    );
  });

  test("par onError and concurrency", () => {
    const branches = { a: agent("x", "t") };
    expectIssue(
      { kind: "parallel", branches, onError: "ignore" },
      "'onError' must be one of: fail, collect",
    );
    expectIssue(
      { kind: "parallel", branches, concurrency: 0 },
      "'concurrency' must be an integer >= 1",
    );
  });

  test("reduce requires a task; agent is optional", () => {
    expectIssue(
      {
        kind: "parallel",
        branches: { a: agent("x", "t") },
        reduce: { agent: "r" },
      },
      "$.reduce: 'task' must be a non-empty string",
    );
    expectValid({
      kind: "parallel",
      branches: { a: agent("x", "t") },
      reduce: { task: "merge {branches}" },
    });
    expectIssue(
      {
        kind: "parallel",
        branches: { a: agent("x", "t") },
        reduce: { agent: "", task: "merge {branches}" },
      },
      "$.reduce: 'agent' must be a non-empty string when present",
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

  test("while requires a single-reference on, condition, body, and max", () => {
    const state = agent("seed", "state", { as: "state", output: "json" });
    expectValid(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        body: agent("worker", "use {current}"),
        max: 3,
      }),
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "state",
        condition: { eq: ["continue", true] },
        body: agent("worker", "work"),
        max: 3,
      }),
      "'on' must be exactly one reference",
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "{state}",
        body: agent("worker", "work"),
        max: 3,
      }),
      "$.steps[1].condition",
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        max: 3,
      }),
      "$.steps[1].body",
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        body: agent("worker", "work"),
      }),
      "'max' is required",
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        body: agent("worker", "work"),
        max: 0,
      }),
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
    expectIssue(
      seq(agent("a", "t", { as: "current" }), agent("b", "t")),
      "reserved name 'current'",
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
        kind: "parallel",
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
      { kind: "parallel", branches: { a: agent("x", "t", { as: "y" }) } },
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
        kind: "parallel",
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

  test("while and loop bodies expose distinct iterative roots", () => {
    const state = agent("seed", "state", { as: "state", output: "json" });
    expectValid(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        body: agent("worker", "iteration {iteration}, use {current}"),
        max: 3,
      }),
    );
    expectIssue(
      seq(state, {
        kind: "while",
        on: "{state}",
        condition: { eq: ["continue", true] },
        body: agent("worker", "use {last}"),
        max: 3,
      }),
      "{last} is only available inside a loop body",
    );
    expectIssue(
      {
        kind: "loop",
        body: agent("worker", "use {current}"),
        max: 3,
      },
      "{current} is only available inside a while body",
    );
  });

  test("nested while resolves on in the enclosing frame and shadows its body", () => {
    expectValid(
      seq(agent("seed", "state", { as: "state", output: "json" }), {
        kind: "while",
        on: "{state}",
        condition: { eq: ["outer", true] },
        max: 2,
        body: {
          kind: "while",
          on: "{current}",
          condition: { eq: ["inner", true] },
          max: 2,
          body: agent("worker", "inner {iteration}: {current}"),
        },
      }),
    );
  });

  test("while preserves map roots and shadows an enclosing loop frame", () => {
    expectValid(
      seq(agent("seed", "list", { as: "list", output: "json" }), {
        kind: "map",
        over: "{list}",
        body: {
          kind: "while",
          on: "{item}",
          condition: { eq: ["continue", true] },
          max: 2,
          body: agent(
            "worker",
            "item {index}: {item}; iteration {iteration}: {current}",
          ),
        },
      }),
    );
    expectValid({
      kind: "loop",
      max: 2,
      body: {
        kind: "while",
        on: "{last}",
        condition: { exists: "continue" },
        max: 2,
        body: agent("worker", "use {current}, not the outer last"),
      },
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
      "{branches} is only available in a parallel reduce task",
    );
    expectIssue(
      agent("a", "use {items}"),
      "{items} is only available in a map reduce task",
    );
    expectValid({
      kind: "parallel",
      branches: { a: agent("x", "t") },
      reduce: { agent: "syn", task: "merge {branches}" },
    });
    expectIssue(
      {
        kind: "parallel",
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
      kind: "parallel",
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
    expect((ref as { body?: FlowNode }).body).toMatchObject({
      kind: "parallel",
    });
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

  test("skips anonymous leaves and reducers", () => {
    const flow = validateFlow({
      kind: "parallel",
      branches: {
        a: { kind: "agent", task: "review A" },
        b: agent("reviewer", "review B"),
      },
      reduce: { task: "merge {branches}" },
    });
    expect([...collectAgentNames(flow)]).toEqual(["reviewer"]);
  });
});

describe("execution options", () => {
  test("skills and tools accept lists, dedupe, and allow an explicit empty", () => {
    const flow = validateFlow({
      kind: "agent",
      task: "t",
      skills: ["code-review", " gh ", "code-review"],
      tools: [],
    });
    expect(flow).toMatchObject({
      skills: ["code-review", "gh"],
      tools: [],
    });
  });

  test("list fields reject non-arrays and empty entries", () => {
    expectIssue(
      { kind: "agent", task: "t", skills: "code-review" },
      "'skills' must be an array of strings, got string",
    );
    expectIssue(
      { kind: "agent", task: "t", tools: ["read", "  "] },
      "'tools' entries must be non-empty strings",
    );
  });

  test("thinking is checked against the known levels", () => {
    expectValid({ kind: "agent", task: "t", thinking: "xhigh" });
    expectIssue(
      { kind: "agent", task: "t", thinking: "very-high" },
      "'thinking' must be one of",
    );
  });

  test("agent nodes and reducers share one option surface", () => {
    const options = {
      model: "m",
      thinking: "low",
      skills: ["code-review"],
      tools: ["read"],
      cwd: "/elsewhere",
      scope: "user",
    };
    const flow = validateFlow({
      kind: "parallel",
      branches: { a: { kind: "agent", task: "t", ...options } },
      reduce: { task: "merge {branches}", ...options },
    }) as {
      branches: { a: Record<string, unknown> };
      reduce: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(options)) {
      expect(flow.branches.a[key]).toEqual(value);
      expect(flow.reduce[key]).toEqual(value);
    }
  });

  test("reducers reject the same bad values agent nodes do", () => {
    expectIssue(
      {
        kind: "map",
        over: "{params.files}",
        body: { kind: "agent", task: "t" },
        reduce: { task: "merge {items}", skills: "gh" },
      },
      "'skills' must be an array of strings",
      { params: [{ name: "files" }] },
    );
  });
});

describe("collectInvocations", () => {
  test("named calls and skill-bearing anonymous calls are collected with paths", () => {
    const flow = validateFlow(
      seq(
        { kind: "agent", task: "anonymous step" },
        agent("scout", "t", { cwd: "/elsewhere", scope: "user" }),
        { kind: "agent", task: "review", skills: ["code-review"] },
        {
          kind: "parallel",
          branches: { a: { kind: "agent", task: "review" } },
          reduce: { task: "merge {branches}" },
        },
      ),
    );
    expect(collectInvocations(flow)).toEqual([
      {
        path: "$.steps[1]",
        agent: "scout",
        skills: undefined,
        cwd: "/elsewhere",
        scope: "user",
      },
      {
        path: "$.steps[2]",
        agent: undefined,
        skills: ["code-review"],
        cwd: undefined,
        scope: undefined,
      },
    ]);
  });

  test("reducers carry their own overrides and a reduce path", () => {
    const flow = validateFlow(
      {
        kind: "map",
        over: "{params.files}",
        body: { kind: "agent", task: "review {item}" },
        reduce: {
          task: "merge {items}",
          agent: "synthesizer",
          skills: ["gh"],
          cwd: "/elsewhere",
          scope: "project",
        },
      },
      { params: [{ name: "files" }] },
    );
    expect(collectInvocations(flow)).toEqual([
      {
        path: "$.reduce",
        agent: "synthesizer",
        skills: ["gh"],
        cwd: "/elsewhere",
        scope: "project",
      },
    ]);
  });

  test("collects model-only anonymous calls and reducers", () => {
    const flow = validateFlow({
      kind: "parallel",
      branches: {
        a: { kind: "agent", task: "t", model: "terra" },
      },
      reduce: { task: "merge {branches}", model: "spark" },
    });
    expect(collectInvocations(flow)).toEqual([
      {
        path: "$.branches.a",
        agent: undefined,
        model: "terra",
        skills: undefined,
        cwd: undefined,
        scope: undefined,
      },
      {
        path: "$.reduce",
        agent: undefined,
        model: "spark",
        skills: undefined,
        cwd: undefined,
        scope: undefined,
      },
    ]);
  });

  test("a flow with nothing to resolve yields no requirements", () => {
    const flow = validateFlow(
      {
        kind: "map",
        over: "{params.files}",
        body: { kind: "agent", task: "review {item}" },
        reduce: { task: "merge {items}" },
      },
      { params: [{ name: "files" }] },
    );
    expect(collectInvocations(flow)).toEqual([]);
  });
});

const gateSwitch = (extra: Record<string, unknown> = {}) =>
  seq(agent("gatekeeper", "inspect", { as: "gate" }), {
    kind: "switch",
    on: "{gate}",
    cases: [
      { when: { eq: ["status", "approved"] }, then: agent("shipper", "ship") },
      {
        when: { exists: "findings" },
        then: seq(agent("fixer", "fix"), agent("checker", "recheck")),
      },
    ],
    else: agent("reporter", "report"),
    ...extra,
  });

describe("switch validation", () => {
  test("a well-formed switch validates", () => {
    expectValid(gateSwitch());
  });

  test("on is required and must be a single reference", () => {
    expectIssue(
      gateSwitch({ on: undefined }),
      "'on' must be a non-empty string",
    );
    expectIssue(
      gateSwitch({ on: "gate" }),
      `'on' must be exactly one reference like "{gate}" or "{pr.state}" (got 'gate')`,
    );
    expectIssue(
      gateSwitch({ on: "check {gate} now" }),
      "'on' must be exactly one reference",
    );
    expectValid(gateSwitch({ on: "{gate.pr.state}" }));
  });

  test("cases must be a non-empty array", () => {
    expectIssue(
      gateSwitch({ cases: [] }),
      "'cases' must be a non-empty array of {when, then} arms",
    );
    expectIssue(gateSwitch({ cases: "nope" }), "'cases' must be a non-empty");
  });

  test("case arms allow exactly when and then", () => {
    expectIssue(
      gateSwitch({
        cases: [
          {
            when: { eq: ["", "x"] },
            then: agent("a", "t"),
            label: "no",
          },
        ],
      }),
      "$.steps[1].cases[0]: unknown key 'label'",
    );
    expectIssue(
      gateSwitch({ cases: [{ then: agent("a", "t") }] }),
      "$.steps[1].cases[0].when: expected a predicate object, got undefined",
    );
    expectIssue(
      gateSwitch({ cases: [{ when: { exists: "x" } }] }),
      "$.steps[1].cases[0].then: expected a flow node object, got undefined",
    );
  });

  test("bad predicates in when carry their path", () => {
    expectIssue(
      gateSwitch({ cases: [{ when: { near: 3 }, then: agent("a", "t") }] }),
      "$.steps[1].cases[0].when: a predicate must have exactly one of",
    );
  });

  test("else is required", () => {
    expectIssue(
      gateSwitch({ else: undefined }),
      "$.steps[1]: 'else' is required (a switch must be total)",
    );
  });

  test("unknown keys on the switch are rejected", () => {
    expectIssue(
      gateSwitch({ default: agent("a", "t") }),
      "unknown key 'default'",
    );
  });

  test("on is scope-checked", () => {
    expectIssue(
      {
        kind: "switch",
        on: "{gate}",
        cases: [{ when: { exists: "x" }, then: agent("a", "t") }],
        else: agent("b", "t"),
      },
      "$.on: unknown reference {gate}",
    );
  });

  test("on may use frame roots like {item} only in their frames", () => {
    expectIssue(
      {
        kind: "switch",
        on: "{item}",
        cases: [{ when: { exists: "x" }, then: agent("a", "t") }],
        else: agent("b", "t"),
      },
      "$.on: {item} is only available inside a map body",
    );
    expectValid(
      seq(agent("s", "list", { as: "files" }), {
        kind: "map",
        over: "{files}",
        body: {
          kind: "switch",
          on: "{item}",
          cases: [{ when: { exists: "x" }, then: agent("a", "t") }],
          else: agent("b", "t"),
        },
      }),
    );
  });

  test("as on an arm is rejected; arms see the enclosing scope", () => {
    expectIssue(
      gateSwitch({ else: agent("reporter", "report", { as: "out" }) }),
      "$.steps[1].else: 'as' is only legal on direct steps of a sequence",
    );
    expectIssue(
      gateSwitch({
        cases: [{ when: { exists: "x" }, then: agent("a", "use {nope}") }],
      }),
      "$.steps[1].cases[0].then.task: unknown reference {nope}",
    );
    expectValid(
      gateSwitch({ else: agent("reporter", "report on {gate.findings}") }),
    );
  });

  test("binding the switch via as is visible to later steps", () => {
    expectValid(
      seq(
        agent("gatekeeper", "inspect", { as: "gate" }),
        {
          kind: "switch",
          on: "{gate}",
          cases: [{ when: { exists: "x" }, then: agent("a", "t") }],
          else: agent("b", "t"),
          as: "outcome",
        },
        agent("closer", "wrap up {outcome}"),
      ),
    );
  });

  test("workflow refs inside arms inline and detect cycles", () => {
    const inner: WorkflowLike = {
      name: "inner",
      params: [],
      flow: { kind: "agent", name: "worker", task: "work" } as FlowNode,
    };
    const resolve = (name: string) =>
      [inner, cyclic].find((def) => def.name === name);
    const cyclic: WorkflowLike = {
      name: "cyclic",
      params: [],
      flow: {
        kind: "switch",
        on: "{params.gate}",
        cases: [
          { when: { exists: "x" }, then: { kind: "workflow", name: "cyclic" } },
        ],
        else: { kind: "agent", task: "t" },
      } as unknown as FlowNode,
    };
    const flow = validateFlow(
      gateSwitch({ else: { kind: "workflow", name: "inner" } }),
      { resolveWorkflow: resolve },
    );
    expect(collectAgentNames(flow)).toContain("worker");
    expectIssue(
      { kind: "workflow", name: "cyclic" },
      "workflow cycle: cyclic → cyclic",
      { resolveWorkflow: resolve },
    );
  });

  test("agents in every arm are collected", () => {
    const flow = validateFlow(gateSwitch());
    const names = collectAgentNames(flow);
    for (const name of ["shipper", "fixer", "checker", "reporter"]) {
      expect(names).toContain(name);
    }
    expect(collectInvocations(flow).map((req) => req.agent)).toContain(
      "reporter",
    );
  });

  test("unquoted on: in YAML parses as a string key", () => {
    const parsed = YAML.parse(
      ["kind: switch", 'on: "{gate}"', "cases: []", "else: null"].join("\n"),
    );
    expect(Object.keys(parsed)).toContain("on");
    expect(parsed.on).toBe("{gate}");
  });
});

describe("value validation", () => {
  test("a well-formed value node validates", () => {
    expectValid(
      seq(agent("scout", "look", { as: "report" }), {
        kind: "value",
        value: {
          outcome: "{report.verdict}",
          summary: "verdict: {report.verdict}",
          fixed: true,
          counts: [1, 2, "{report.total}"],
        },
      }),
    );
  });

  test("value key is required; null is a legal value", () => {
    expectIssue({ kind: "value" }, "$: 'value' is required (any JSON value)");
    expectValid({ kind: "value", value: null });
  });

  test("unknown keys are rejected", () => {
    expectIssue(
      { kind: "value", value: 1, output: "json" },
      "unknown key 'output'",
    );
  });

  test("templates in nested strings are scope-checked with their path", () => {
    expectIssue(
      { kind: "value", value: { report: ["{missing}"] } },
      "$.value.report[0]: unknown reference {missing}",
    );
  });

  test("non-JSON values are rejected with their path", () => {
    // YAML 1.2 core parses .nan/.inf to non-finite numbers, which JSON
    // persistence would silently turn into null.
    const fromYaml = YAML.parse(
      ["kind: value", "value:", "  score: .nan", "  bound: .inf"].join("\n"),
    );
    expectIssue(fromYaml, "$.value.score: 'value' must be JSON");
    expectIssue(fromYaml, "$.value.bound: 'value' must be JSON");
    // Programmatic callers can hand validateFlow arbitrary JS objects.
    expectIssue(
      { kind: "value", value: { when: new Date(0) } },
      "$.value.when: 'value' must be JSON (got Date)",
    );
    expectIssue(
      { kind: "value", value: [() => 1] },
      "$.value[0]: 'value' must be JSON (got function)",
    );
    expectValid({
      kind: "value",
      value: { nested: [1.5, "x", null, { deep: true }] },
    });
  });
});
