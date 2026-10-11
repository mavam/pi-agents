import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import { WaitInterrupted } from "../../src/agents/types.js";
import {
  closeService,
  createFaux,
  createGatedFaux,
  jsonlStorage,
  MODEL,
  openService,
  parentOf,
  tempDir,
  until,
} from "./helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
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
  test("spawn runs the job and offers the result for delivery", async () => {
    const service = await open();
    const spawned = await service.spawn({
      job: "review src",
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
    await service.spawn({ job: "a", name: "a", cwd: ".", model: MODEL });
    await service.spawn({ job: "b", name: "b", cwd: ".", model: MODEL });
    const outcome = await service.wait(["a", "b"]);
    expect(outcome.timedOut).toEqual([]);
    expect(outcome.agents.map((agent) => agent.result?.text)).toEqual([
      "done: a",
      "done: b",
    ]);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
    // The wait took the results, so none is queued.
    expect(service.get("a")?.queued).toBeUndefined();
    expect(service.get("b")?.queued).toBeUndefined();
  });

  test("messaging a closed agent reopens it until it answers", async () => {
    const service = await open();
    await service.spawn({ job: "first", name: "w", cwd: ".", model: MODEL });
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
    await service.spawn({ job: "x", name: "w", cwd: ".", model: MODEL });
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    if (delivery) await service.acknowledge(delivery);
    expect(service.get("w")?.state).toBe("failed");
    expect(service.list().map((agent) => agent.name)).toEqual(["w"]);
  });

  test("an agent knows which answer replied to its job", async () => {
    const service = await open();
    await service.spawn({ job: "first", name: "w", cwd: ".", model: MODEL });
    const first = (await service.wait(["w"])).agents[0];
    expect(first?.jobAnswer).toBe(first?.result?.entryId);
    await service.send("w", "second", "auto");
    const second = (await service.wait(["w"])).agents[0];
    expect(second?.result?.text).toBe("done: second");
    expect(second?.jobAnswer).toBe(first?.result?.entryId);
    expect(second?.result?.entryId).not.toBe(second?.jobAnswer);
  });

  test("user prompts never deliver into the parent", async () => {
    const service = await open();
    await service.spawn({ job: "first", name: "w", cwd: ".", model: MODEL });
    await service.wait(["w"]);
    await service.prompt("w", "from the user", "auto");
    await until(
      () => service.get("w")?.result?.text === "done: [user] from the user",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("a carried result closes the agent after a user prompt", async () => {
    const service = await open();
    const agent = await service.spawn({
      job: "first",
      name: "w",
      cwd: ".",
      model: MODEL,
    });
    const outcome = await service.waitFor([{ kind: "agent", id: agent.id }], {
      carrier: { call: "c1" },
    });
    expect(outcome.deliveries).toHaveLength(1);
    expect(outcome.agents[0]?.result?.text).toBe("done: first");
    expect(service.get("w")?.closed).toBe(false);
    expect(service.get("w")?.queued).toBeUndefined();

    await service.prompt("w", "from the user", "auto");
    await until(
      () =>
        service.get("w")?.state === "idle" &&
        service.get("w")?.result?.text === "done: [user] from the user",
    );
    expect(service.get("w")?.closed).toBe(false);
    // The user answered a different turn; the carried delivery still names
    // the answer to the parent's request, not the agent's latest answer.
    expect(service.pendingDeliveries().map((delivery) => delivery.id)).toEqual(
      outcome.deliveries,
    );
    expect(service.get("w")?.queued).toBeUndefined();

    parentOf(service).hold(outcome.deliveries);
    await until(() => service.get("w")?.closed === true);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("wait closes an interrupted agent resumed by a user prompt", async () => {
    const { models } = createGatedFaux();
    const service = await open({ models });
    const agent = await service.spawn({
      job: "hold",
      name: "w",
      cwd: ".",
      model: MODEL,
    });
    await until(() => service.get("w")?.state === "working");
    const waiting = service.waitFor([{ kind: "agent", id: agent.id }], {
      carrier: { call: "c1" },
    });
    parentOf(service).attend();
    await expect(waiting).rejects.toBeInstanceOf(WaitInterrupted);

    await service.interrupt("w");
    expect(service.get("w")?.state).toBe("interrupted");
    expect(service.get("w")?.closed).toBe(false);
    expect(service.pendingDeliveries()).toEqual([]);
    await service.prompt("w", "continue", "auto");
    await until(() => service.get("w")?.state === "idle");
    expect(service.get("w")?.closed).toBe(false);
    expect(service.pendingDeliveries()).toEqual([]);

    const outcome = await service.waitFor([{ kind: "agent", id: agent.id }], {
      carrier: { call: "c2" },
    });
    expect(outcome.agents[0]?.result?.text).toBe("done: [user] continue");
    // The interrupted parent request is gone, and the user turn has no
    // delivery. The wait still consumed its answer and must close it.
    expect(outcome.deliveries).toEqual([]);
    expect(service.get("w")?.closed).toBe(true);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("interrupt aborts work without delivering", async () => {
    const { models } = createFaux((prompt) => `${prompt} `.repeat(400), {
      tokensPerSecond: 20,
    });
    const service = await open({ models });
    await service.spawn({ job: "long", name: "w", cwd: ".", model: MODEL });
    await until(() => service.get("w")?.state === "working");
    await service.interrupt("w");
    await until(() => service.get("w")?.state === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("names are unique among open agents and generated when absent", async () => {
    const service = await open();
    const first = await service.spawn({ job: "x", cwd: ".", model: MODEL });
    const second = await service.spawn({ job: "y", cwd: ".", model: MODEL });
    expect(first.name).toBe("agent");
    expect(second.name).toBe("agent-2");
    const profiled = await service.spawn({
      job: "z",
      profile: "explorer",
      cwd: ".",
      model: MODEL,
    });
    expect(profiled.name).toBe("explorer");
    await expect(
      service.spawn({ job: "x", name: "agent", cwd: ".", model: MODEL }),
    ).rejects.toThrow("already exists");
    await expect(
      service.spawn({ job: "x", name: "bad name", cwd: ".", model: MODEL }),
    ).rejects.toThrow("Invalid agent name");
  });

  test("concurrent spawns never share a name", async () => {
    const service = await open();
    const results = await Promise.allSettled([
      service.spawn({ job: "x", name: "same", cwd: ".", model: MODEL }),
      service.spawn({ job: "y", name: "same", cwd: ".", model: MODEL }),
      service.spawnGraph({
        name: "same",
        agents: [
          { job: "a", cwd: ".", model: MODEL },
          { job: "b", cwd: ".", model: MODEL },
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
      service.spawn({ job: "x", cwd: ".", model: MODEL }),
      service.spawn({ job: "y", cwd: ".", model: MODEL }),
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
    await service.spawn({ job: "x", name: "w", cwd: ".", model: MODEL });
    await until(() => service.get("w")?.state === "working");
    await service.stop("w");
    expect(service.list().map((agent) => agent.name)).toEqual([]);
    expect(service.list({ includeClosed: true })).toHaveLength(1);
    expect(service.pendingDeliveries()).toEqual([]);
    await service.spawn({ job: "y", name: "w", cwd: ".", model: MODEL });
    expect(service.list()).toHaveLength(1);
    expect(service.get("w")?.job).toBe("y");
  });

  test("a wait ends when the parent is needed and consumes nothing", async () => {
    const faux = createGatedFaux();
    const service = await open({ models: faux.models });
    await service.spawn({ job: "hold", name: "w", cwd: ".", model: MODEL });
    await service.spawn({ job: "quick", name: "q", cwd: ".", model: MODEL });
    await until(() => service.get("q")?.state === "idle");
    const waiting = service.wait(["w", "q"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    parentOf(service).attend();
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaitInterrupted);
    expect((error as WaitInterrupted).reason).toBe("attention");
    expect(service.get("w")?.state).toBe("working");
    // The finished agent's result still arrives as a message.
    expect(service.pendingDeliveries().map((each) => each.name)).toEqual(["q"]);
    faux.release();
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
    await first.spawn({ job: "long", name: "w", cwd: ".", model: MODEL });
    await until(() => first.get("w")?.state === "working");
    await closeService(first);

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
    await closeService(second);
    services = services.filter((service) => service !== second);

    const third = await open({
      storage: await jsonlStorage(directory),
      models: fast.models,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(third.pendingDeliveries()).toEqual([]);
    expect(third.get("w")?.state).toBe("idle");
  });

  test("a crash while stopping an agent never resumes its job", async () => {
    const directory = tempDir();
    const worker = fileURLToPath(new URL("./stop-worker.ts", import.meta.url));
    const crashed = Bun.spawn(["bun", worker, directory], { stdout: "ignore" });
    expect(await crashed.exited).toBe(0);

    const service = await open({
      storage: await jsonlStorage(directory),
      models: createFaux().models,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [victim] = service.list({ includeClosed: true });
    expect(victim).toMatchObject({ name: "victim", closed: true });
    expect(victim?.result).toBeUndefined();
  });
});
