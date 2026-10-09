import { afterEach, describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import {
  createFaux,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "./helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await service.close();
  services = [];
});

async function open(
  options: Parameters<typeof openService>[0] = {},
): Promise<AgentService> {
  const service = await openService(options);
  services.push(service);
  return service;
}

describe("AgentService", () => {
  test("spawn runs the task and offers the result for delivery", async () => {
    const service = await open();
    const spawned = await service.spawn({
      task: "review src",
      name: "reviewer",
      cwd: process.cwd(),
      model: MODEL,
    });
    expect(spawned.name).toBe("reviewer");
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    expect(delivery?.outcome.kind).toBe("answered");
    if (delivery?.outcome.kind === "answered")
      expect(delivery.outcome.result.text).toBe("done: review src");
    expect(service.get("reviewer")?.state).toBe("idle");
    expect(service.get("reviewer")?.result?.text).toBe("done: review src");
    // Until the parent takes it, the answer is queued.
    expect(service.get("reviewer")?.queued).toBe(true);

    if (delivery) await service.acknowledge(delivery);
    expect(service.get("reviewer")?.queued).toBeUndefined();
    expect(service.pendingDeliveries()).toEqual([]);
    // A delivered answer closes the agent; it stays reachable by name.
    expect(service.list()).toEqual([]);
    expect(service.get("reviewer")?.closed).toBe(true);
  });

  test("wait consumes results instead of delivering them", async () => {
    const service = await open();
    await service.spawn({ task: "a", name: "a", cwd: ".", model: MODEL });
    await service.spawn({ task: "b", name: "b", cwd: ".", model: MODEL });
    const outcome = await service.wait(["a", "b"]);
    expect(outcome.timedOut).toEqual([]);
    expect(outcome.agents.map((agent) => agent.result?.text)).toEqual([
      "done: a",
      "done: b",
    ]);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("messaging a closed agent reopens it until it answers", async () => {
    const service = await open();
    await service.spawn({ task: "first", name: "w", cwd: ".", model: MODEL });
    await service.wait(["w"]);
    expect(service.get("w")?.closed).toBe(true);
    await service.send("w", "second", "auto");
    expect(service.get("w")?.closed).toBe(false);
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    if (delivery) await service.acknowledge(delivery);
    expect(service.get("w")?.closed).toBe(true);
  });

  test("failed agents stay open after delivery", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    ]);
    const service = await open({ models });
    await service.spawn({ task: "x", name: "w", cwd: ".", model: MODEL });
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    if (delivery) await service.acknowledge(delivery);
    expect(service.get("w")?.state).toBe("failed");
    expect(service.list().map((agent) => agent.name)).toEqual(["w"]);
  });

  test("an agent knows which answer replied to its task", async () => {
    const service = await open();
    await service.spawn({ task: "first", name: "w", cwd: ".", model: MODEL });
    const first = (await service.wait(["w"])).agents[0];
    expect(first?.taskAnswer).toBe(first?.result?.entryId);
    await service.send("w", "second", "auto");
    const second = (await service.wait(["w"])).agents[0];
    expect(second?.result?.text).toBe("done: second");
    expect(second?.taskAnswer).toBe(first?.result?.entryId);
    expect(second?.result?.entryId).not.toBe(second?.taskAnswer);
  });

  test("send starts a new turn on an idle agent", async () => {
    const service = await open();
    await service.spawn({ task: "first", name: "w", cwd: ".", model: MODEL });
    await service.wait(["w"]);
    await service.send("w", "second", "auto");
    const outcome = await service.wait(["w"]);
    expect(outcome.agents[0]?.result?.text).toBe("done: second");
  });

  test("user prompts never deliver into the parent", async () => {
    const service = await open();
    await service.spawn({ task: "first", name: "w", cwd: ".", model: MODEL });
    await service.wait(["w"]);
    await service.prompt("w", "from the user", "auto");
    await until(
      () => service.get("w")?.result?.text === "done: [user] from the user",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("interrupt aborts work without delivering", async () => {
    const { models } = createFaux((prompt) => `${prompt} `.repeat(400), {
      tokensPerSecond: 20,
    });
    const service = await open({ models });
    await service.spawn({ task: "long", name: "w", cwd: ".", model: MODEL });
    await until(() => service.get("w")?.state === "working");
    await service.interrupt("w");
    await until(() => service.get("w")?.state === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("names are unique among open agents and generated when absent", async () => {
    const service = await open();
    const first = await service.spawn({ task: "x", cwd: ".", model: MODEL });
    const second = await service.spawn({ task: "y", cwd: ".", model: MODEL });
    expect(first.name).toBe("agent");
    expect(second.name).toBe("agent-2");
    const profiled = await service.spawn({
      task: "z",
      profile: "explorer",
      cwd: ".",
      model: MODEL,
    });
    expect(profiled.name).toBe("explorer");
    await expect(
      service.spawn({ task: "x", name: "agent", cwd: ".", model: MODEL }),
    ).rejects.toThrow("already exists");
    await expect(
      service.spawn({ task: "x", name: "bad name", cwd: ".", model: MODEL }),
    ).rejects.toThrow("Invalid agent name");
  });

  test("concurrent spawns never share a name", async () => {
    const service = await open();
    const results = await Promise.allSettled([
      service.spawn({ task: "x", name: "same", cwd: ".", model: MODEL }),
      service.spawn({ task: "y", name: "same", cwd: ".", model: MODEL }),
      service.spawnGraph({
        name: "same",
        agents: [
          { task: "a", cwd: ".", model: MODEL },
          { task: "b", cwd: ".", model: MODEL },
        ],
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    for (const result of results.slice(1))
      if (result.status === "rejected")
        expect(String(result.reason)).toContain("named same already exists");
    const generated = await Promise.all([
      service.spawn({ task: "x", cwd: ".", model: MODEL }),
      service.spawn({ task: "y", cwd: ".", model: MODEL }),
    ]);
    expect(generated.map((info) => info.name).sort()).toEqual([
      "agent",
      "agent-2",
    ]);
  });

  test("stop ends and hides an agent and frees its name", async () => {
    const { models } = createFaux((prompt) => `${prompt} `.repeat(400), {
      tokensPerSecond: 20,
    });
    const service = await open({ models });
    await service.spawn({ task: "x", name: "w", cwd: ".", model: MODEL });
    await until(() => service.get("w")?.state === "working");
    await service.stop("w");
    expect(service.list().map((agent) => agent.name)).toEqual([]);
    expect(service.list({ includeClosed: true })).toHaveLength(1);
    expect(service.pendingDeliveries()).toEqual([]);
    await service.spawn({ task: "y", name: "w", cwd: ".", model: MODEL });
    expect(service.list()).toHaveLength(1);
    expect(service.get("w")?.task).toBe("y");
  });

  test("tool allowlists reject unknown tools", async () => {
    const service = await open();
    const agent = await service.spawn({
      task: "x",
      name: "reader",
      cwd: ".",
      model: MODEL,
      tools: ["read", "grep"],
    });
    expect(agent.tools).toEqual(["read", "grep"]);
    await expect(
      service.spawn({ task: "x", cwd: ".", model: MODEL, tools: ["nope"] }),
    ).rejects.toThrow("Unknown tools: nope");
  });
});

describe("durability", () => {
  test("an interrupted turn resumes and delivers once after reopening", async () => {
    const directory = tempDir();
    const slow = createFaux((prompt) => `${prompt} `.repeat(60), {
      tokensPerSecond: 200,
    });
    const first = await openService({
      storage: await jsonlStorage(directory),
      models: slow.models,
    });
    await first.spawn({ task: "long", name: "w", cwd: ".", model: MODEL });
    await until(() => first.get("w")?.state === "working");
    await first.close();

    const fast = createFaux();
    const second = await open({
      storage: await jsonlStorage(directory),
      models: fast.models,
    });
    await until(() => second.pendingDeliveries().length === 1);
    const [delivery] = second.pendingDeliveries();
    expect(delivery?.name).toBe("w");
    expect(delivery?.outcome.kind).toBe("answered");
    if (delivery) await second.acknowledge(delivery);
    await second.close();
    services = services.filter((service) => service !== second);

    const third = await open({
      storage: await jsonlStorage(directory),
      models: fast.models,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(third.pendingDeliveries()).toEqual([]);
    expect(third.get("w")?.state).toBe("idle");
  });
});
