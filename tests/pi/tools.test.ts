import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
} from "../../src/agents/types.js";
import type { SessionHost } from "../../src/pi/session.js";
import { SteerWatch } from "../../src/pi/steering.js";
import {
  FitLines,
  formatCall,
  registerAgentTools,
  renderDetails,
  startedView,
} from "../../src/pi/tools.js";
import { createFaux, MODEL, openService, until } from "../agents/helpers.js";

let service: AgentService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

// biome-ignore lint/suspicious/noExplicitAny: tool parameters vary.
type AnyTool = ToolDefinition<any, any>;

function tools(steering: SteerWatch): Map<string, AnyTool> {
  const registered = new Map<string, AnyTool>();
  const pi = {
    registerTool: (tool: AnyTool) => registered.set(tool.name, tool),
    getThinkingLevel: () => undefined,
  } as unknown as ExtensionAPI;
  const host = { ensure: async () => service } as unknown as SessionHost;
  registerAgentTools(pi, host, steering);
  return registered;
}

describe("waiting tools", () => {
  test("a steer from the user ends a wait; the agent keeps working", async () => {
    const { models } = createFaux((prompt) => `${prompt} `.repeat(400), {
      tokensPerSecond: 20,
    });
    service = await openService({ models });
    await service.spawn({ task: "long", name: "w", cwd: ".", model: MODEL });
    await until(() => service?.get("w")?.state === "working");
    const steering = new SteerWatch();
    const wait = tools(steering).get("agent_wait");
    const running = wait?.execute(
      "call-1",
      { names: ["w"] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    steering.steer();
    const result = await running;
    expect(result?.content[0]).toMatchObject({
      text: "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages.",
    });
    expect(service.get("w")?.state).toBe("working");
    await service.stop("w");
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
      { ensure: async () => service } as unknown as SessionHost,
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
