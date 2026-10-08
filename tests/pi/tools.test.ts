import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import type { SessionHost } from "../../src/pi/session.js";
import { SteerWatch } from "../../src/pi/steering.js";
import { registerAgentTools } from "../../src/pi/tools.js";
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
