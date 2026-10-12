import { afterEach, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
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
import { registerAgentTools } from "../../src/pi/tools.js";
import { FitLines } from "../../src/ui/tool-views.js";
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
    getActiveTools: () => [],
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

/**
 * Pi stores a call's result right after the call returns, details
 * included, and the result names the deliveries a wait took.
 */
function storeResult(details: unknown): void {
  const ids = (details as { deliveries?: string[] } | undefined)?.deliveries;
  if (ids === undefined) return;
  setTimeout(() => {
    if (service) parentOf(service).hold(ids);
  }, 0);
}

/** Agent tools over a service whose model holds prompts with `hold`. */
async function gated() {
  const faux = createGatedFaux();
  release = faux.release;
  service = await openService({ models: faux.models });
  const registered = tools();
  let calls = 0;
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
      `call-${++calls}`,
      params,
      options.signal,
      options.onUpdate,
      ctx,
    );
    const output = result.structuredContent;
    expect([...Value.Errors(tool.outputSchema, output)], name).toEqual([]);
    storeResult(result.details);
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

/** One frame of a tool call as Pi draws it: the call, then its result. */
function drawFrame(
  tool: AnyTool | undefined,
  args: unknown,
  result?: { text?: string; details: unknown },
  { isPartial = false, isError = false, expanded = false } = {},
): string[] {
  const context = { args, expanded, isError, isPartial, state: {} };
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
    // Spawns and sends return at once; a script waits with agent_wait.
    expect(
      (await run("agent_spawn", { job: "one", name: "a" })).output,
    ).toMatchObject({ kind: "agent", name: "a" });
    expect((await run("agent_wait", { names: ["a"] })).output).toEqual({
      agents: [{ ...a, result: "done: one" }],
      graphs: [],
      pending: [],
    });
    await run("agent_send", { name: "a", message: "two" });
    await run("agent_wait", { names: ["a"] });
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
    await run("agent_spawn", { job: "one", name: "a" });
    await run("agent_wait", { names: ["a"] });
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
    await run("agent_spawn", { job: "one", name: "a" });
    await run("agent_wait", { names: ["a"] });
    await run("agent_send", { name: "a", message: "fail two" });
    const failed = await run("agent_wait", { names: ["a"] });
    expect(failed.output).toEqual({
      agents: [
        { kind: "agent", name: "a", state: "failed", error: "cannot fail two" },
      ],
      graphs: [],
      pending: [],
    });
    expect(failed.text).toBe("## a (failed)\nError: cannot fail two");
  });

  test("waits that end early return the state and what is pending", async () => {
    const run = await gated();
    const w = { kind: "agent", name: "w", state: "working" };
    const pending = { agents: [w], graphs: [], pending: ["w"] };
    await run("agent_spawn", { job: "hold", name: "w" });
    // A timeout.
    expect(
      (await run("agent_wait", { names: ["w"], timeout: 0.05 })).output,
    ).toEqual(pending);
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
    // A steer from the user, also after steering the agent itself.
    await run("agent_send", { name: "w", message: "and more" });
    const steered = firstUpdate();
    const waitingAgain = run(
      "agent_wait",
      { names: ["w"] },
      { onUpdate: steered.onUpdate },
    );
    await steered.started;
    parentOf(service as AgentService).attend();
    expect((await waitingAgain).output).toEqual(pending);
    expect(
      (await run("agent_send", { name: "w", message: "more" })).output,
    ).toEqual(w);
  });

  test("graphs report failed, skipped, and stopped agents", async () => {
    const run = await gated();
    await run("agent_spawn_graph", {
      name: "g",
      agents: [
        { job: "fail one", name: "a" },
        { job: "two", name: "b", after: ["a"] },
      ],
    });
    expect(
      (
        (await run("agent_wait", { names: ["g"] })).output as {
          graphs: unknown[];
        }
      ).graphs[0],
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
            { job: "hold", name: "c" },
            { job: "two", name: "d", after: ["c"] },
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
    job: "a",
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

  test("long results reach scripts whole", () => {
    const output = agentOutput(info("x".repeat(50_000)), () => undefined);
    expect(output.result).toHaveLength(50_000);
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
    answer.text = "the job's answer";
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
      "the job's answer",
    );
  });
});

describe("call results", () => {
  test("an expanded graph call keeps each task's lines", () => {
    const call = tools()
      .get("agent_spawn_graph")
      ?.renderCall?.(
        {
          name: "g",
          agents: [
            { name: "a", job: "Steps:\n1. read  the code\n\n2. report" },
            { name: "b", job: "Merge.", after: ["a"] },
          ],
        },
        plainTheme,
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
      "  b after a: Merge.",
    ]);
  });

  test("an error result shows its reason", () => {
    const theme = {
      fg: (name: string, text: string) => `<${name}>${text}`,
      bold: (text: string) => text,
    };
    const render = (details: unknown, text = "terminated") =>
      tools()
        .get("agent_send")
        ?.renderResult?.(
          { content: [{ type: "text", text }], details },
          { expanded: false, isPartial: false },
          theme,
          { isError: true, state: {} },
        )
        .render(80);
    // Pi never ran the call because the model's message broke off.
    expect(render(undefined)).toEqual(["  <error>terminated"]);
    // The tool threw, and Pi passes empty details.
    expect(render({})).toEqual(["  <error>terminated"]);
    expect(render(undefined, "")).toEqual(["  <error>Failed"]);
  });

  test("results draw what the call saw, the same live and replayed", async () => {
    const run = await gated();
    const spawn = tools().get("agent_spawn_graph");
    const args = {
      name: "audit",
      agents: [
        { name: "map", job: "map" },
        { name: "report", job: "hold report", after: ["map"] },
      ],
    };
    // A spawn shows what it started, which stays true as the agents work.
    const started = { details: (await run("agent_spawn_graph", args)).details };
    const tree = [
      "✦ spawn graph audit",
      "  ├─ map faux-1",
      "  └─ report after map faux-1",
    ];
    expect(drawFrame(spawn, args, started)).toEqual(tree);
    // A wait that timed out marks what it gave up on, and says so.
    const wait = tools().get("agent_wait");
    const waitArgs = { names: ["audit"], timeout: 0.3 };
    const timedOut = {
      details: (await run("agent_wait", waitArgs)).details,
    };
    const gaveUp = [
      "✦ wait audit timeout=0.3s",
      "  ⊠ audit graph 1/2",
      "  ├─ ● map faux-1 2.8k",
      "  └─ ⊠ report after map faux-1",
      "  Timed out",
    ];
    expect(drawFrame(wait, waitArgs, timedOut)).toEqual(gaveUp);
    // Both replay the same after the agents finished.
    release?.();
    await run("agent_wait", { names: ["audit"] });
    expect(drawFrame(spawn, args, structuredClone(started))).toEqual(tree);
    expect(drawFrame(wait, waitArgs, structuredClone(timedOut))).toEqual(
      gaveUp,
    );
  });

  test("collapsed lines end in an ellipsis; expanded ones wrap", () => {
    expect(
      new FitLines("  one two three four", false)
        .render(12)
        .map((line) => stripVTControlCharacters(line)),
    ).toEqual(["  one two t…"]);
    // A wrapped line continues under its own indentation.
    expect(new FitLines("  one two three four", true).render(12)).toEqual([
      "  one two",
      "  three four",
    ]);
  });
});
