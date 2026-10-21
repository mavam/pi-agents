import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import { WaitInterrupted } from "../../src/agents/types.js";
import { formatAgentLine } from "../../src/ui/format.js";
import { panelCompare } from "../../src/ui/panel.js";
import { buildRows } from "../../src/ui/rows.js";
import {
  briefly,
  closeService,
  createFaux,
  createGatedFaux,
  heldUntilAborted,
  jsonlStorage,
  lastUserText,
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
    const spawned = await service.spawnGraph({
      agents: [
        {
          job: "review src",
          name: "reviewer",
          cwd: process.cwd(),
          model: MODEL,
        },
      ],
    });
    expect(spawned.name).toBe("reviewer");
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    expect(delivery?.kind).toBe("graph");
    const outcome =
      delivery?.kind === "graph" ? delivery.nodes[0]?.outcome : undefined;
    expect(outcome?.kind).toBe("answered");
    if (outcome?.kind === "answered")
      expect(outcome.result.text).toBe("done: review src");
    expect(service.get("reviewer")?.state).toBe("idle");
    expect(service.get("reviewer")?.result?.text).toBe("done: review src");
    // Until the parent takes it, the answer is queued.
    expect(service.getGraph(spawned.id)?.queued).toBe(true);
    const rows = buildRows(
      {
        agents: service.list(),
        graphs: service.graphs(),
        agent: (id) => service.get(id),
      },
      panelCompare,
      () => true,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== "agent") throw new Error("Expected the single agent");
    expect(row.agent.queued).toBe(true);
    const line = formatAgentLine(row.agent, Date.now());
    expect(line).toStartWith("◐ reviewer");
    expect(line).toContain("result queued");

    if (delivery) await service.acknowledge(delivery);
    expect(service.get("reviewer")?.queued).toBeUndefined();
    expect(service.pendingDeliveries()).toEqual([]);
    // A delivered answer closes the agent; it stays reachable by name.
    expect(service.list()).toEqual([]);
    expect(service.get("reviewer")?.closed).toBe(true);
  });

  test("wait consumes results instead of delivering them", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [{ job: "a", name: "a", cwd: ".", model: MODEL }],
    });
    await service.spawnGraph({
      agents: [{ job: "b", name: "b", cwd: ".", model: MODEL }],
    });
    const outcome = await service.wait(["a", "b"]);
    expect(outcome.timedOut).toEqual([]);
    expect(
      outcome.graphs.map((graph) => service.get(graph.name)?.result?.text),
    ).toEqual(["done: a", "done: b"]);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
    // The wait took the results, so none is queued.
    expect(service.get("a")?.queued).toBeUndefined();
    expect(service.get("b")?.queued).toBeUndefined();
  });

  test("messaging a closed agent reopens it until it answers", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [{ job: "first", name: "w", cwd: ".", model: MODEL }],
    });
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
    await service.spawnGraph({
      agents: [{ job: "x", name: "w", cwd: ".", model: MODEL }],
    });
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    if (delivery) await service.acknowledge(delivery);
    expect(delivery?.kind === "graph" && delivery.nodes[0]?.outcome).toEqual({
      kind: "failed",
      reason: "boom",
    });
    expect(service.get("w")?.state).toBe("failed");
    expect(service.list().map((agent) => agent.name)).toEqual(["w"]);
  });

  test("an agent knows which answer replied to its job", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [{ job: "first", name: "w", cwd: ".", model: MODEL }],
    });
    await service.wait(["w"]);
    const first = service.get("w");
    expect(first?.jobAnswer).toBe(first?.result?.entryId);
    await service.send("w", "second", "auto");
    const second = (await service.wait(["w"])).agents[0];
    expect(second?.result?.text).toBe("done: second");
    expect(second?.jobAnswer).toBe(first?.result?.entryId);
    expect(second?.result?.entryId).not.toBe(second?.jobAnswer);
  });

  test("user prompts never deliver into the parent", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [{ job: "first", name: "w", cwd: ".", model: MODEL }],
    });
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
    const agent = await service
      .spawnGraph({
        agents: [
          {
            job: "first",
            name: "w",
            cwd: ".",
            model: MODEL,
          },
        ],
      })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    const outcome = await service.waitFor([{ kind: "agent", id: agent }], {
      carrier: true,
    });
    expect(outcome.deliveries).toHaveLength(1);
    expect(service.get("w")?.result?.text).toBe("done: first");
    expect(service.get("w")?.closed).toBe(false);
    expect(service.get("w")?.queued).toBeUndefined();
    const carried = service.get("w");
    if (!carried) throw new Error("Expected the carried result's agent");
    expect(formatAgentLine(carried, Date.now())).not.toContain("result queued");

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

  test("a resumed agent answers the parent's interrupted request", async () => {
    const { models } = createGatedFaux();
    const service = await open({ models });
    const agent = await service
      .spawnGraph({
        agents: [
          {
            job: "hold",
            name: "w",
            cwd: ".",
            model: MODEL,
          },
        ],
      })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    await until(() => service.get("w")?.state === "working");
    const waiting = service.waitFor([{ kind: "agent", id: agent }], {
      carrier: true,
    });
    parentOf(service).attend();
    await expect(waiting).rejects.toBeInstanceOf(WaitInterrupted);

    await service.interrupt("w");
    expect(service.get("w")?.state).toBe("interrupted");
    expect(service.get("w")?.closed).toBe(false);
    expect(service.pendingDeliveries()).toEqual([]);
    await service.prompt("w", "continue", "auto");
    await until(() => service.pendingDeliveries().length === 1);
    expect(service.getGraph(service.get("w")?.graph ?? "")?.queued).toBe(true);

    const outcome = await service.waitFor([{ kind: "agent", id: agent }], {
      carrier: true,
    });
    expect(service.get("w")?.result?.text).toBe("done: [user] continue");
    expect(outcome.deliveries).toHaveLength(1);
    parentOf(service).hold(outcome.deliveries);
    await until(() => service.get("w")?.closed === true);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("an earlier answer never settles an interrupted request", async () => {
    let started = false;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 20 }, () => async (context, options) => {
        const prompt = lastUserText(context);
        started = true;
        if (prompt.includes("slow")) await briefly(options?.signal);
        if (prompt.includes("block")) await heldUntilAborted(options?.signal);
        return fauxAssistantMessage(`done: ${prompt}`);
      }),
    );
    const service = await open({ models });
    await service.spawnGraph({
      agents: [{ job: "slow", name: "w", cwd: ".", model: MODEL }],
    });
    await until(() => service.get("w")?.state === "working");
    // Queued while the job runs: admitted before the job's answer.
    await until(() => started);
    await service.send("w", "block", "followUp");
    await until(() => service.get("w")?.result?.text === "done: slow");
    await until(() => service.get("w")?.state === "working");
    await service.interrupt("w");
    await until(() => service.get("w")?.state === "interrupted");
    await until(() => service.pendingDeliveries().length === 1);
    const [job] = service.pendingDeliveries();
    expect(job?.kind).toBe("graph");
    if (job) await service.acknowledge(job);
    expect(service.get("w")?.closed).toBe(false);

    await service.prompt("w", "continue", "auto");
    await until(() => service.pendingDeliveries().length === 1);
    const [resumed] = service.pendingDeliveries();
    expect(resumed?.kind === "agent" && resumed.requestIds).toEqual([
      "parent:1",
    ]);
    expect(
      resumed?.kind === "agent" &&
        resumed.outcome.kind === "answered" &&
        resumed.outcome.result.text,
    ).toBe("done: [user] continue");
  });

  test("interrupt aborts work without delivering", async () => {
    let started = false;
    const { models } = createFaux(
      (prompt) => {
        started = true;
        return `${prompt} `.repeat(400);
      },
      {
        tokensPerSecond: 20,
      },
    );
    const service = await open({ models });
    await service.spawnGraph({
      agents: [{ job: "long", name: "w", cwd: ".", model: MODEL }],
    });
    await until(() => started);
    await service.interrupt("w");
    await until(() => service.get("w")?.state === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("names are unique among open agents and generated when absent", async () => {
    const service = await open();
    const first = await service.spawnGraph({
      agents: [{ job: "x", cwd: ".", model: MODEL }],
    });
    const second = await service.spawnGraph({
      agents: [{ job: "y", cwd: ".", model: MODEL }],
    });
    expect(first.name).toBe("agent");
    expect(second.name).toBe("agent-2");
    const profiled = await service.spawnGraph({
      agents: [
        {
          job: "z",
          profile: "explorer",
          cwd: ".",
          model: MODEL,
        },
      ],
    });
    expect(profiled.name).toBe("explorer");
    await expect(
      service.spawnGraph({
        agents: [{ job: "x", name: "agent", cwd: ".", model: MODEL }],
      }),
    ).rejects.toThrow("already exists");
    await expect(
      service.spawnGraph({
        agents: [{ job: "x", name: "bad name", cwd: ".", model: MODEL }],
      }),
    ).rejects.toThrow("Invalid agent name");
  });

  test("concurrent spawns never share a name", async () => {
    const service = await open();
    const results = await Promise.allSettled([
      service.spawnGraph({
        agents: [{ job: "x", name: "same", cwd: ".", model: MODEL }],
      }),
      service.spawnGraph({
        agents: [{ job: "y", name: "same", cwd: ".", model: MODEL }],
      }),
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
      service.spawnGraph({ agents: [{ job: "x", cwd: ".", model: MODEL }] }),
      service.spawnGraph({ agents: [{ job: "y", cwd: ".", model: MODEL }] }),
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
    await service.spawnGraph({
      agents: [{ job: "x", name: "w", cwd: ".", model: MODEL }],
    });
    await until(() => service.get("w")?.state === "working");
    await service.stop("w");
    expect(service.list().map((agent) => agent.name)).toEqual([]);
    expect(service.list({ includeClosed: true })).toHaveLength(1);
    expect(service.pendingDeliveries()).toEqual([]);
    await service.spawnGraph({
      agents: [{ job: "y", name: "w", cwd: ".", model: MODEL }],
    });
    expect(service.list()).toHaveLength(1);
    expect(service.get("w")?.job).toBe("y");
  });

  test("a wait ends when the parent is needed and consumes nothing", async () => {
    const faux = createGatedFaux();
    const service = await open({ models: faux.models });
    await service.spawnGraph({
      agents: [{ job: "hold", name: "w", cwd: ".", model: MODEL }],
    });
    await service.spawnGraph({
      agents: [{ job: "quick", name: "q", cwd: ".", model: MODEL }],
    });
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
    await first.spawnGraph({
      agents: [{ job: "long", name: "w", cwd: ".", model: MODEL }],
    });
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
    expect(delivery?.kind === "graph" && delivery.nodes[0]?.outcome.kind).toBe(
      "answered",
    );
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

  test("a crash while stopping an agent resumes nothing below it", async () => {
    const directory = tempDir();
    const worker = fileURLToPath(new URL("./stop-worker.ts", import.meta.url));
    const crashed = Bun.spawn(["bun", worker, directory], { stdout: "ignore" });
    expect(await crashed.exited).toBe(0);

    // No stopped agent's work runs again, not even briefly.
    const called: string[] = [];
    const service = await open({
      storage: await jsonlStorage(directory),
      models: createFaux((prompt) => {
        called.push(prompt);
        return "resumed";
      }).models,
    });
    await until(async () => (await service.liveTasks()).length === 0);
    expect(called).toEqual([]);
    const agents = service.list({ includeClosed: true });
    expect(agents.map((info) => [info.name, info.closed])).toEqual([
      ["victim", true],
      ["victim.c", true],
      ["victim.d", true],
    ]);
  });
});
