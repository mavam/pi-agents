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
import { registerAgentTools, renderDetails } from "../../src/pi/tools.js";
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

  test("a call that started work shows what started, not its state", () => {
    expect(
      renderDetails(
        { at: 5_000, started: true, graphs: [graph], agents },
        false,
        plain,
      ),
    ).toBe(
      ["audit · graph of 2", "├─ map · luna", "└─ report ← map · luna"].join(
        "\n",
      ),
    );
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
