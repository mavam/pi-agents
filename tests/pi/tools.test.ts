import { afterEach, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderToolOutputType } from "@earendil-works/pi-codemode";
import {
  type AgentToolUpdateCallback,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { AgentService } from "../../src/agents/service.js";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
} from "../../src/agents/types.js";
import { SkillCatalog } from "../../src/catalog/skills.js";
import agentExtension from "../../src/index.js";
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
  tempDir,
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
 * included, and the result names the deliveries a wait took. Resolves once
 * they count as delivered.
 */
async function storeResult(details: unknown): Promise<void> {
  const ids = (details as { deliveries?: string[] } | undefined)?.deliveries;
  if (ids === undefined || !service) return;
  const current = service;
  parentOf(current).hold(ids);
  while (current.pendingDeliveries().some((each) => ids.includes(each.id)))
    await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Agent tools over a service whose model holds prompts with `hold`. */
async function gated() {
  const faux = createGatedFaux();
  release = faux.release;
  service = await openService({ models: faux.models });
  const registered = tools();
  let calls = 0;
  /**
   * Run a direct tool call and return its text and structured output,
   * which must match the tool's output schema.
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
    // Pi prepares arguments before it runs a tool.
    const result = await tool.execute(
      `call-${++calls}`,
      tool.prepareArguments?.(params) ?? params,
      options.signal,
      options.onUpdate,
      ctx,
    );
    expect(
      [...Value.Errors(tool.outputSchema, result.structuredContent)],
      name,
    ).toEqual([]);
    // IDs differ from run to run; the tests compare the rest.
    const output = withoutIds(result.structuredContent);
    await storeResult(result.details);
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

/** A script's output without the `id` fields. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "id")
      .map(([key, each]) => [key, withoutIds(each)]),
  );
}

/** A script's view of a group of one agent. */
function single(name: string, state: string, agent: Record<string, unknown>) {
  return {
    kind: "graph",
    name,
    state,
    stopped: false,
    agents: [{ name, after: [], end: true, ...agent }],
  };
}

describe("tool exposure", () => {
  test("Pi exposes waits only to the model and keeps other tools composable", async () => {
    const cwd = tempDir();
    const runtime = await createAgentSessionRuntime(
      async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir: tempDir(),
          settingsManager: SettingsManager.inMemory(),
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [agentExtension],
          },
        });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            noTools: "builtin",
          })),
          services,
          diagnostics: services.diagnostics,
        };
      },
      { cwd, sessionManager: SessionManager.inMemory(cwd) },
    );
    try {
      const errors: unknown[] = [];
      await runtime.session.bindExtensions({
        mode: "json",
        onError: (error) => errors.push(error),
      });
      expect(errors).toEqual([]);
      expect(runtime.session.getActiveToolNames()).toContain("agent_wait");
      const callable = runtime.session.getCallableToolNames();
      expect(callable).not.toContain("agent_wait");
      for (const name of [
        "agent_spawn",
        "agent_send",
        "agent_status",
        "agent_stop",
      ])
        expect(callable).toContain(name);
    } finally {
      await runtime.dispose();
    }
  });

  test("agent_spawn shows how to list a single agent's fields", () => {
    const prepare = tools().get("agent_spawn")?.prepareArguments;
    const lead = { name: "lead", job: "review", spawn: true };
    expect(() => prepare?.(lead)).toThrow(
      'Move job, spawn into an entry of agents. Arguments are always an agents array, also for a single agent: {"agents": [{"name": "lead"',
    );
    expect(prepare?.({ agents: [lead] })).toEqual({ agents: [lead] });
  });
});

describe("structured output", () => {
  test("every agent tool declares its structured output", () => {
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
    // Spawns and sends return at once; the model waits with agent_wait. A
    // spawn starts a group, of one agent here, until its result arrived.
    expect(
      (await run("agent_spawn", { agents: [{ job: "one", name: "a" }] }))
        .output,
    ).toEqual(single("a", "working", { outcome: "working" }));
    expect((await run("agent_wait", { names: ["a"] })).output).toEqual({
      agents: [],
      graphs: [
        {
          ...single("a", "idle", { outcome: "answered", result: "done: one" }),
          outcome: "succeeded",
        },
      ],
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
    await run("agent_spawn", { agents: [{ job: "one", name: "a" }] });
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
    await run("agent_spawn", { agents: [{ job: "one", name: "a" }] });
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
    const pending = {
      agents: [],
      graphs: [single("w", "working", { outcome: "working" })],
      pending: ["w"],
    };
    // A wait that something interrupted reports what it was asked for.
    const interrupted = { agents: [w], graphs: [], pending: ["w"] };
    await run("agent_spawn", { agents: [{ job: "hold", name: "w" }] });
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
    expect((await waiting).output).toEqual(interrupted);
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
    expect((await waitingAgain).output).toEqual(interrupted);
    expect(
      (await run("agent_send", { name: "w", message: "more" })).output,
    ).toEqual(w);
  });

  test("graphs report failed, skipped, and stopped agents", async () => {
    const run = await gated();
    await run("agent_spawn", {
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
      outcome: "failed",
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
        await run("agent_spawn", {
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
          outcome: "stopped",
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
      .get("agent_spawn")
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
      "spawn g",
      "  a → b",
      "  a: Steps:",
      "    1. read  the code",
      "",
      "    2. report",
      "",
      "  b after a: Merge.",
    ]);
  });

  test("a call's name is bold, as Pi draws its own tools", () => {
    const theme = {
      fg: (name: string, text: string) => `<${name}>${text}</>`,
      bold: (text: string) => `*${text}*`,
    };
    const call = tools()
      .get("agent_stop")
      ?.renderCall?.({ name: "scout" }, theme, {
        expanded: false,
        state: {},
      });
    expect(call?.render(80)).toEqual(["<toolTitle>*stop*</> scout"]);
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
    const spawn = tools().get("agent_spawn");
    const args = {
      name: "audit",
      agents: [
        { name: "map", job: "map" },
        { name: "report", job: "hold report", after: ["map"] },
      ],
    };
    // A spawn shows what it started, which stays true as the agents work.
    const started = { details: (await run("agent_spawn", args)).details };
    const tree = [
      "spawn audit",
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
    // Token counts depend on the prompt's context, so only their place counts.
    const drawWait = (result: { details: unknown }) =>
      drawFrame(wait, waitArgs, result).map((line) =>
        line.replace(/ \d+(\.\d+)?k$/, " <tokens>"),
      );
    const gaveUp = [
      "wait audit timeout=0.3s",
      "  ⊠ audit graph 1/2",
      "  ├─ ● map faux-1 <tokens>",
      "  └─ ⊠ report after map faux-1",
      "  Timed out",
    ];
    expect(drawWait(timedOut)).toEqual(gaveUp);
    // Both replay the same after the agents finished.
    release?.();
    await run("agent_wait", { names: ["audit"] });
    expect(drawFrame(spawn, args, structuredClone(started))).toEqual(tree);
    expect(drawWait(structuredClone(timedOut))).toEqual(gaveUp);
  });

  test("a spawn of one agent reads as that agent", async () => {
    const run = await gated();
    const spawn = tools().get("agent_spawn");
    const args = { agents: [{ name: "scout", job: "Look.", spawn: true }] };
    const started = await run("agent_spawn", args);
    expect(started.text).toBe("Started scout.");
    // The call names the agent, which its result doesn't repeat.
    expect(drawFrame(spawn, args, started)).toEqual([
      "spawn scout spawn=true",
      "  Look.",
    ]);
    // Its result reads as its answer, without a graph.
    const waited = await run("agent_wait", { names: ["scout"] });
    expect(waited.text).toBe("scout answered:\n\ndone: Look.");
    expect(
      drawFrame(tools().get("agent_wait"), { names: ["scout"] }, waited).map(
        (line) => line.replace(/ \d+(\.\d+)?k$/, " <tokens>"),
      ),
    ).toEqual(["wait scout", "  ● scout faux-1 <tokens>"]);
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
