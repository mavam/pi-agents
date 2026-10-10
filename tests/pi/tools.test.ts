import { afterEach, describe, expect, test } from "bun:test";
import { renderToolOutputType } from "@earendil-works/pi-codemode";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { AgentService } from "../../src/agents/service.js";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
} from "../../src/agents/types.js";
import { SkillCatalog } from "../../src/catalog/skills.js";
import { agentOutput, graphOutput } from "../../src/pi/output.js";
import type { SessionHost } from "../../src/pi/session.js";
import {
  FitLines,
  formatCall,
  registerAgentTools,
  renderDetails,
  startedView,
} from "../../src/pi/tools.js";
import {
  closeService,
  createGatedFaux,
  MODEL,
  openService,
  parentOf,
} from "../agents/helpers.js";

const noSkills = new SkillCatalog(async () => []);

let service: AgentService | undefined;
let release: (() => void) | undefined;

afterEach(async () => {
  release?.();
  release = undefined;
  if (service) await closeService(service);
  service = undefined;
});

// biome-ignore lint/suspicious/noExplicitAny: tool parameters vary.
type AnyTool = ToolDefinition<any, any>;

function tools(): Map<string, AnyTool> {
  const registered = new Map<string, AnyTool>();
  const pi = {
    registerTool: (tool: AnyTool) => registered.set(tool.name, tool),
    getThinkingLevel: () => undefined,
  } as unknown as ExtensionAPI;
  const host = {
    ensure: async () => service,
    skills: noSkills,
  } as unknown as SessionHost;
  registerAgentTools(pi, host);
  return registered;
}

const ctx = {
  cwd: process.cwd(),
  model: { provider: MODEL.provider, id: MODEL.modelId },
  isProjectTrusted: () => false,
} as unknown as ExtensionContext;

/** Agent tools over a service whose model holds prompts with `hold`. */
async function gated() {
  const faux = createGatedFaux();
  release = faux.release;
  service = await openService({ models: faux.models });
  const registered = tools();
  /**
   * Run a tool and return its text and what a script gets, which must match
   * the tool's output schema.
   */
  return async (
    name: string,
    params: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback<unknown>;
    } = {},
  ): Promise<{ text: string; details: unknown; output: unknown }> => {
    const tool = registered.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    const result = await tool.execute(
      "call",
      params,
      options.signal,
      options.onUpdate,
      ctx,
    );
    const output = result.structuredContent;
    expect([...Value.Errors(tool.outputSchema, output)], name).toEqual([]);
    const [first] = result.content;
    return {
      text: first?.type === "text" ? first.text : "",
      details: result.details,
      output,
    };
  };
}

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

/**
 * One frame of a tool call as Pi draws it: both renderers run, sharing
 * `state`, and the call draws after them.
 */
function drawFrame(
  tool: AnyTool | undefined,
  args: unknown,
  state: object,
  result?: { text?: string; details: unknown },
  { isPartial = false, isError = false, expanded = false } = {},
): string[] {
  const context = { args, expanded, isError, isPartial, state };
  const call = tool?.renderCall?.(args, plainTheme, context);
  const drawn =
    result &&
    tool?.renderResult?.(
      {
        content: [{ type: "text", text: result.text ?? "" }],
        details: result.details,
      },
      { expanded, isPartial },
      plainTheme,
      context,
    );
  return [...(call?.render(80) ?? []), ...(drawn?.render(80) ?? [])];
}

/** Whether lines show an agent's state glyph. */
const GLYPHS = /[◉○●✗⊘⊖]/;

/** Resolves once a wait reported progress, and thus listens for steers. */
function firstUpdate(): {
  onUpdate: AgentToolUpdateCallback<unknown>;
  started: Promise<void>;
} {
  let resolve!: () => void;
  const started = new Promise<void>((done) => {
    resolve = done;
  });
  return { onUpdate: () => resolve(), started };
}

describe("script output", () => {
  test("every agent tool declares the output scripts get", () => {
    const registered = tools();
    for (const tool of registered.values())
      expect(tool.outputSchema, tool.name).toBeDefined();
    const stop = registered.get("agent_stop");
    expect(renderToolOutputType(stop?.outputSchema)).toBe(
      '{ kind: "agent" | "graph"; name: string; state: "working" | "waiting" | "idle" | "failed" | "interrupted" | "skipped"; }',
    );
  });

  test("agents resolve to what their latest turn produced", async () => {
    const run = await gated();
    const a = { kind: "agent", name: "a", state: "idle" };
    expect(
      (await run("agent_spawn", { task: "one", name: "a", wait: 60 })).output,
    ).toEqual({ ...a, result: "done: one" });
    expect(
      (await run("agent_send", { name: "a", message: "two", wait: 60 })).output,
    ).toEqual({ ...a, result: "done: two" });
    expect((await run("agent_status", { name: "a" })).output).toEqual({
      agents: [{ ...a, result: "done: two" }],
      graphs: [],
    });
    expect((await run("agent_wait", { names: ["a"] })).output).toEqual({
      agents: [{ ...a, result: "done: two" }],
      graphs: [],
      pending: [],
    });
    expect((await run("agent_stop", { name: "a" })).output).toEqual(a);
  });

  test("an interrupted turn doesn't report an earlier answer", async () => {
    const run = await gated();
    await run("agent_spawn", { task: "one", name: "a", wait: 60 });
    expect(
      (await run("agent_send", { name: "a", message: "hold two" })).output,
    ).toEqual({ kind: "agent", name: "a", state: "working" });
    await run("agent_stop", { name: "a" });
    const interrupted = { kind: "agent", name: "a", state: "interrupted" };
    expect((await run("agent_status", { name: "a" })).output).toEqual({
      agents: [interrupted],
      graphs: [],
    });
    const waited = await run("agent_wait", { names: ["a"] });
    expect(waited.output).toEqual({
      agents: [interrupted],
      graphs: [],
      pending: [],
    });
    expect(waited.text).toBe("## a (interrupted)");
  });

  test("a failed turn reports its error, not an earlier answer", async () => {
    const run = await gated();
    await run("agent_spawn", { task: "one", name: "a", wait: 60 });
    const failed = await run("agent_send", {
      name: "a",
      message: "fail two",
      wait: 60,
    });
    expect(failed.output).toEqual({
      kind: "agent",
      name: "a",
      state: "failed",
      error: "cannot fail two",
    });
    expect(failed.text).toBe("## a (failed)\nError: cannot fail two");
  });

  test("status lists open agents; answered ones need their name", async () => {
    const run = await gated();
    await run("agent_spawn", { task: "one", name: "a", wait: 60 });
    await run("agent_spawn", { task: "hold", name: "w" });
    const w = { kind: "agent", name: "w", state: "working" };
    expect((await run("agent_status", {})).output).toEqual({
      agents: [w],
      graphs: [],
    });
    expect((await run("agent_status", { name: "a" })).output).toEqual({
      agents: [
        { kind: "agent", name: "a", state: "idle", result: "done: one" },
      ],
      graphs: [],
    });
  });

  test("waits that end early return the state and what is pending", async () => {
    const run = await gated();
    const w = { kind: "agent", name: "w", state: "working" };
    // A timeout.
    expect(
      (await run("agent_spawn", { task: "hold", name: "w", wait: 1 })).output,
    ).toEqual(w);
    // An abort.
    const abort = new AbortController();
    const aborted = firstUpdate();
    const waiting = run(
      "agent_wait",
      { names: ["w"] },
      { signal: abort.signal, onUpdate: aborted.onUpdate },
    );
    await aborted.started;
    abort.abort();
    expect((await waiting).output).toEqual({
      agents: [w],
      graphs: [],
      pending: ["w"],
    });
    // A steer from the user, to an agent that is steered itself.
    const steered = firstUpdate();
    const sending = run(
      "agent_send",
      { name: "w", message: "and more", wait: 60 },
      { onUpdate: steered.onUpdate },
    );
    await steered.started;
    parentOf(service as AgentService).attend();
    expect((await sending).output).toEqual(w);
    expect(
      (await run("agent_send", { name: "w", message: "more" })).output,
    ).toEqual(w);
  });

  test("graphs resolve to how each agent ended its task", async () => {
    const run = await gated();
    expect(
      (
        await run("agent_spawn_graph", {
          name: "g",
          agents: [
            { task: "one", name: "a" },
            { task: "two", name: "b", after: ["a"] },
          ],
          wait: 60,
        })
      ).output,
    ).toMatchObject({
      kind: "graph",
      name: "g",
      state: "idle",
      stopped: false,
      agents: [
        {
          name: "a",
          after: [],
          end: false,
          outcome: "answered",
          result: "done: one",
        },
        {
          name: "b",
          after: ["a"],
          end: true,
          outcome: "answered",
          result: expect.stringContaining("two"),
        },
      ],
    });
  });

  test("graphs report failed, skipped, and stopped agents", async () => {
    const run = await gated();
    expect(
      (
        await run("agent_spawn_graph", {
          name: "g",
          agents: [
            { task: "fail one", name: "a" },
            { task: "two", name: "b", after: ["a"] },
          ],
          wait: 60,
        })
      ).output,
    ).toEqual({
      kind: "graph",
      name: "g",
      state: "failed",
      stopped: false,
      agents: [
        {
          name: "a",
          after: [],
          end: false,
          outcome: "failed",
          error: "cannot fail one",
        },
        { name: "b", after: ["a"], end: true, outcome: "skipped" },
      ],
    });
    expect(
      (
        await run("agent_spawn_graph", {
          name: "h",
          agents: [
            { task: "hold", name: "c" },
            { task: "two", name: "d", after: ["c"] },
          ],
        })
      ).output,
    ).toEqual({
      kind: "graph",
      name: "h",
      state: "working",
      stopped: false,
      agents: [
        { name: "c", after: [], end: false, outcome: "working" },
        { name: "d", after: ["c"], end: true, outcome: "waiting" },
      ],
    });
    expect((await run("agent_stop", { name: "h" })).output).toEqual({
      kind: "graph",
      name: "h",
      state: "interrupted",
    });
    expect((await run("agent_status", { name: "h" })).output).toEqual({
      agents: [],
      graphs: [
        {
          kind: "graph",
          name: "h",
          state: "interrupted",
          stopped: true,
          agents: [
            { name: "c", after: [], end: false, outcome: "stopped" },
            { name: "d", after: ["c"], end: true, outcome: "stopped" },
          ],
        },
      ],
    });
  });
});

describe("output", () => {
  const info = (result: string): AgentInfo => ({
    id: "1",
    name: "a",
    task: "a",
    cwd: "/repo",
    state: "idle",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE },
    activity: {},
    result: {
      agentId: "1",
      name: "a",
      entryId: 1,
      text: result,
      stopReason: "stop",
    },
  });

  test("long results are cut like the text the model reads", () => {
    const output = agentOutput(info("x".repeat(50_000)), () => undefined);
    expect(output.result).toHaveLength(40_000);
    expect(output.truncated).toBe(true);
  });

  test("failed agents carry their error", () => {
    const failed = info("");
    failed.state = "failed";
    if (failed.result) failed.result.errorMessage = "boom";
    expect(agentOutput(failed, () => undefined)).toEqual({
      kind: "agent",
      name: "a",
      state: "failed",
      error: "boom",
    });
  });

  test("a turn that failed before any output says why", () => {
    const failed = info("an earlier answer");
    failed.state = "failed";
    failed.unanswered = { reason: "no_model", current: false };
    expect(agentOutput(failed, () => undefined).error).toBe("no_model");
    failed.unanswered = {
      reason: "model_error",
      detail: "overloaded",
      current: false,
    };
    expect(agentOutput(failed, () => undefined).error).toBe("overloaded");
  });

  test("an interrupted turn keeps what it wrote", () => {
    const interrupted = info("half an answer");
    interrupted.state = "interrupted";
    interrupted.unanswered = { reason: "aborted", current: true };
    expect(agentOutput(interrupted, () => undefined).result).toBe(
      "half an answer",
    );
  });

  test("a graph keeps the answer to its task, not later replies", () => {
    const later = info("a later reply");
    const answer = { ...(later.result as NonNullable<AgentInfo["result"]>) };
    answer.text = "the task's answer";
    const graph: GraphInfo = {
      id: "10",
      name: "g",
      policy: "allSettled",
      state: "idle",
      closed: false,
      stopped: false,
      createdAt: 0,
      stateSince: 0,
      nodes: [
        {
          agentId: "1",
          name: "a",
          inputs: [],
          end: true,
          outcome: { kind: "answered", result: answer },
        },
      ],
      usage: { ...EMPTY_USAGE },
    };
    expect(graphOutput(graph, () => later).agents[0]?.result).toBe(
      "the task's answer",
    );
  });
});

describe("waiting tools", () => {
  test("a steer from the user ends a wait; the agent keeps working", async () => {
    const run = await gated();
    await run("agent_spawn", { task: "hold", name: "w" });
    const { onUpdate, started } = firstUpdate();
    const waiting = run("agent_wait", { names: ["w"] }, { onUpdate });
    await started;
    parentOf(service as AgentService).attend();
    const result = await waiting;
    expect(result.text).toBe(
      "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages.",
    );
    expect(result.output).toMatchObject({ pending: ["w"] });
    expect(service?.get("w")?.state).toBe("working");
  });

  test("waiting calls draw what they started, never live states", async () => {
    const run = await gated();
    const draw = tools();
    /** Run a waiting call, abort it after its first progress, and draw both. */
    const waitOnce = async (name: string, args: Record<string, unknown>) => {
      const tool = draw.get(name);
      const progress: unknown[] = [];
      const abort = new AbortController();
      const { onUpdate, started } = firstUpdate();
      const waiting = run(name, args, {
        signal: abort.signal,
        onUpdate: (update) => {
          progress.push(update.details);
          onUpdate(update);
        },
      });
      await started;
      abort.abort();
      const result = await waiting;
      const state = {};
      const partial = drawFrame(
        tool,
        args,
        state,
        { details: progress[0] },
        { isPartial: true },
      );
      const expanded = drawFrame(
        tool,
        args,
        state,
        { details: progress[0] },
        { isPartial: true, expanded: true },
      );
      const final = drawFrame(tool, args, state, result);
      // A replay has no progress and draws the same.
      expect(drawFrame(tool, args, {}, result)).toEqual(final);
      return { tool, partial, expanded, final };
    };
    const args = {
      name: "g",
      wait: 60,
      agents: [
        { name: "a", task: "hold" },
        { name: "b", task: "hold", after: ["a"] },
      ],
    };
    const graph = await waitOnce("agent_spawn_graph", args);
    const tree = ["├─ a · faux-1", "└─ b ← a · faux-1"];
    expect(graph.partial).toEqual([
      "✦ spawn graph g · graph of 2",
      ...tree,
      "  wait=60s",
      "  a → b",
    ]);
    expect(graph.expanded.slice(0, 3)).toEqual([
      "✦ spawn graph g · graph of 2",
      ...tree,
    ]);
    expect(graph.expanded.join("\n")).not.toMatch(GLYPHS);
    // Where waiting stopped, without what started.
    expect(graph.final[0]).toBe("✦ spawn graph g");
    expect(graph.final.join("\n")).not.toContain("graph of 2");
    expect(graph.final).toContain("Stopped waiting");
    expect(graph.final.join("\n")).toMatch(GLYPHS);
    // Waits and sends started nothing: while waiting, only the call.
    for (const [name, params] of [
      ["agent_wait", { names: ["g"] }],
      ["agent_send", { name: "a", message: "more", wait: 60 }],
    ] as const) {
      const waited = await waitOnce(name, params);
      expect(waited.partial, name).toEqual(drawFrame(waited.tool, params, {}));
      expect(waited.final.join("\n"), name).toMatch(GLYPHS);
    }
  });
});

describe("call results", () => {
  const plain = (_color: string, text: string) => text;
  const agent = (id: string, name: string): AgentInfo => ({
    id,
    name,
    task: name,
    cwd: "/repo",
    model: { provider: "openai", modelId: "luna" },
    state: "working",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE, input: 1_000 },
    activity: {},
  });
  const agents = [agent("1", "map"), agent("2", "report")];
  const graph: GraphInfo = {
    id: "10",
    name: "audit",
    policy: "allSettled",
    state: "working",
    closed: false,
    stopped: false,
    createdAt: 0,
    stateSince: 0,
    nodes: [
      { agentId: "1", name: "map", inputs: [], end: false },
      { agentId: "2", name: "report", inputs: ["1"], end: true },
    ],
    usage: { ...EMPTY_USAGE },
  };

  test("a started graph draws below its call's title", () => {
    const details = { at: 5_000, started: true, graphs: [graph], agents };
    const view = {
      title: "audit",
      pairs: { failFast: true },
      body: "map → report\nmap: Map the code.\n\nreport ← map: Write it up.",
      collapsed: "map → report",
    };
    const started = startedView(details, plain);
    expect(
      formatCall("spawn graph", view, false, plain, undefined, started),
    ).toBe(
      [
        "✦ spawn graph audit · graph of 2",
        "├─ map · luna",
        "└─ report ← map · luna",
        "  failFast=true",
        "  map → report",
      ].join("\n"),
    );
    expect(
      formatCall("spawn graph", view, true, plain, undefined, started),
    ).toBe(
      [
        "✦ spawn graph audit · graph of 2",
        "├─ map · luna",
        "└─ report ← map · luna",
        "",
        "  failFast=true",
        "  map → report",
        "  map: Map the code.",
        "",
        "  report ← map: Write it up.",
      ].join("\n"),
    );
    // A started agent needs nothing beyond its call.
    expect(startedView({ ...details, graphs: [] }, plain)).toBeUndefined();
  });

  test("an expanded graph call keeps each task's lines", () => {
    const tools = new Map<string, AnyTool>();
    registerAgentTools(
      {
        registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
        getThinkingLevel: () => undefined,
      } as unknown as ExtensionAPI,
      {
        ensure: async () => service,
        skills: noSkills,
      } as unknown as SessionHost,
    );
    const call = tools.get("agent_spawn_graph")?.renderCall?.(
      {
        name: "g",
        agents: [
          { name: "a", task: "Steps:\n1. read  the code\n\n2. report" },
          { name: "b", task: "Merge.", after: ["a"] },
        ],
      },
      {
        fg: (_name: string, text: string) => text,
        bold: (text: string) => text,
      },
      { expanded: true, state: {} },
    );
    expect(call?.render(80)).toEqual([
      "✦ spawn graph g",
      "  a → b",
      "  a: Steps:",
      "    1. read  the code",
      "",
      "    2. report",
      "",
      "  b ← a: Merge.",
    ]);
  });

  test("an error result shows its reason", () => {
    const tools = new Map<string, AnyTool>();
    registerAgentTools(
      {
        registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
        getThinkingLevel: () => undefined,
      } as unknown as ExtensionAPI,
      {
        ensure: async () => service,
        skills: noSkills,
      } as unknown as SessionHost,
    );
    const theme = {
      fg: (name: string, text: string) => `<${name}>${text}`,
      bold: (text: string) => text,
    };
    const render = (
      details: unknown,
      isError: boolean,
      {
        text = "terminated",
        expanded = false,
        width = 80,
        state = {},
      }: {
        text?: string;
        expanded?: boolean;
        width?: number;
        state?: object;
      } = {},
    ) =>
      tools
        .get("agent_send")
        ?.renderResult?.(
          { content: [{ type: "text", text }], details },
          { expanded, isPartial: false },
          theme,
          { isError, state },
        )
        .render(width);
    const details = { at: 5_000, agents: [agent("1", "map")] };
    // Pi never ran the call because the model's message broke off.
    expect(render(undefined, true)).toEqual(["<error>terminated"]);
    // The tool threw, and Pi passes empty details.
    expect(render({}, true)).toEqual(["<error>terminated"]);
    // Missing details alone count as an error.
    expect(render(undefined, false)).toEqual(["<error>terminated"]);
    // An error with valid details still shows its reason.
    expect(render(details, true)).toEqual(["<error>terminated"]);
    // An error without text still says it failed.
    expect(render(undefined, true, { text: "" })).toEqual(["<error>Failed"]);
    // Collapsed truncates; expanded wraps.
    const long = "connection reset by peer";
    expect(render(undefined, true, { text: long, width: 12 })).toHaveLength(1);
    expect(
      render(undefined, true, { text: long, width: 16, expanded: true })
        ?.length,
    ).toBeGreaterThan(1);
    // Results with details render as before.
    expect(render(details, false)?.join("\n")).toContain("map");
    const state: { started?: unknown } = {};
    expect(render({ ...details, started: true }, false, { state })).toEqual([]);
    expect(state.started).toBeDefined();
  });

  test("a waiting call shows what it started, then the outcome", () => {
    const tool = tools().get("agent_spawn_graph");
    const args = {
      name: "audit",
      wait: 60,
      agents: [
        { name: "map", task: "Map the code." },
        { name: "report", task: "Write it up.", after: ["map"] },
      ],
    };
    const state = {};
    const partial = (details: unknown) =>
      drawFrame(tool, args, state, { details }, { isPartial: true });
    const started = { at: 5_000, started: true, graphs: [graph], agents };
    const waiting = [
      "✦ spawn graph audit · graph of 2",
      "├─ map · luna",
      "└─ report ← map · luna",
      "  wait=60s",
      "  map → report",
    ];
    // While it waits, the panel shows the live states.
    expect(partial(started)).toEqual(waiting);
    // Progress without what started adds nothing.
    expect(partial({ at: 5_000, graphs: [graph], agents })).toEqual(waiting);
    // The outcome replaces what started, as its replay draws it.
    const done = { ...graph, state: "idle" as const };
    const result = { details: { at: 5_000, graphs: [done], agents } };
    const outcome = drawFrame(tool, args, state, result);
    expect(outcome[0]).toBe("✦ spawn graph audit");
    expect(outcome.join("\n")).not.toContain("graph of 2");
    expect(outcome.join("\n")).toContain("audit · graph");
    expect(outcome).toEqual(drawFrame(tool, args, {}, result));
    // So does an error after progress.
    partial(started);
    const error = { text: "boom", details: {} };
    const failed = drawFrame(tool, args, state, error, { isError: true });
    expect(failed[0]).toBe("✦ spawn graph audit");
    expect(failed).toContain("boom");
    expect(failed).toEqual(drawFrame(tool, args, {}, error, { isError: true }));
  });

  test("wrapped lines continue under their indentation", () => {
    expect(new FitLines("  one two three four", true).render(12)).toEqual([
      "  one two",
      "  three four",
    ]);
  });

  test("other calls show the agents' states", () => {
    expect(
      renderDetails({ at: 5_000, graphs: [graph], agents }, false, plain),
    ).toBe(
      [
        "◉ audit · graph 0/2 · 5s",
        "├─ ◉ map · luna · 5s · 1.0k",
        "└─ ◉ report ← map · luna · 5s · 1.0k",
      ].join("\n"),
    );
  });
});
