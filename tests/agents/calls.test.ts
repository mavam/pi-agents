import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import type { GraphSpec, SpawnSpec } from "../../src/agents/types.js";
import {
  closeService,
  createFaux,
  createGatedFaux,
  hostOf,
  MODEL,
  openService,
  until,
} from "./helpers.js";

let services: AgentService[] = [];
let releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  for (const service of services) await closeService(service);
  services = [];
});

/** A service whose model records every prompt it answers. */
async function open(): Promise<{ service: AgentService; prompts: string[] }> {
  const prompts: string[] = [];
  const { models } = createFaux((prompt) => {
    prompts.push(prompt);
    return `done: ${prompt}`;
  });
  const service = await openService({ models });
  services.push(service);
  return { service, prompts };
}

/** A service whose model holds prompts with `hold` until the test ends. */
async function gated(): Promise<AgentService> {
  const faux = createGatedFaux();
  releases.push(faux.release);
  const service = await openService({ models: faux.models });
  services.push(service);
  return service;
}

function agent(name: string | undefined, task: string): SpawnSpec {
  return { ...(name ? { name } : {}), task, cwd: ".", model: MODEL };
}

const pair: GraphSpec = {
  name: "g",
  agents: [agent("x", "one"), { ...agent("y", "two"), after: ["x"] }],
};

async function requests(service: AgentService, name: string) {
  const id = service.get(name)?.id as string;
  const state = await hostOf(service).harness.harness.snapshot(
    AgentsDoc,
    BACKGROUND_CONTEXT,
  );
  return Object.keys(state?.agents[id]?.requests ?? {});
}

describe("keyed calls", () => {
  test("a repeated spawn returns what its first run created", async () => {
    const { service, prompts } = await open();
    const first = await service.spawn(agent("a", "task"), { call: "c1" });
    const again = await service.spawn(agent("a", "task"), { call: "c1" });
    expect(again.id).toBe(first.id);
    expect(service.list({ includeClosed: true })).toHaveLength(1);
    await service.wait(["a"]);
    expect(prompts).toEqual(["task"]);
    // Another call creates another agent.
    const other = await service.spawn(agent(undefined, "task"), {
      call: "c2",
    });
    expect(other.id).not.toBe(first.id);
  });

  test("a repeated graph spawn returns what its first run created", async () => {
    const { service, prompts } = await open();
    const first = await service.spawnGraph(pair, { call: "g1" });
    const again = await service.spawnGraph(pair, { call: "g1" });
    expect(again.id).toBe(first.id);
    expect(again.nodes.map((node) => node.agentId)).toEqual(
      first.nodes.map((node) => node.agentId),
    );
    expect(service.graphs({ includeClosed: true })).toHaveLength(1);
    expect(service.list({ includeClosed: true })).toHaveLength(2);
    await service.wait(["g"]);
    expect(prompts.filter((prompt) => prompt === "one")).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.startsWith("two"))).toHaveLength(
      1,
    );
  });

  test("a repeated send messages its agent once", async () => {
    const { service, prompts } = await open();
    await service.spawn(agent("a", "task"), { call: "c1" });
    await service.wait(["a"]);
    const first = await service.send("a", "more", "auto", { call: "m1" });
    expect(await requests(service, "a")).toEqual(["call:m1"]);
    const again = await service.send("a", "more", "auto", { call: "m1" });
    expect(again.id).toBe(first.id);
    await service.wait(["a"]);
    // Delivered and gone from the record, the request still repeats once.
    await service.send("a", "more", "auto", { call: "m1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prompts).toEqual(["task", "more"]);
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("a repeated send finds its agent after its name moved", async () => {
    const { service, prompts } = await open();
    const first = await service.spawn(agent("a", "task"));
    await service.send("a", "more", "auto", { call: "m1" });
    await service.wait(["a"]);
    await service.stop("a");
    const next = await service.spawn(agent("a", "other"));
    const again = await service.send("a", "more", "auto", { call: "m1" });
    expect(again.id).toBe(first.id);
    await service.wait(["a"]);
    expect(prompts).toEqual(["task", "more", "other"]);
    expect(service.get("a")?.id).toBe(next.id);
  });

  test("a repeated stop doesn't stop newer work", async () => {
    const service = await gated();
    await service.spawn(agent("w", "first"));
    await service.wait(["w"]);
    await service.stop("w", { call: "s1" });
    expect(service.get("w")?.closed).toBe(true);
    await service.send("w", "hold on", "auto");
    await until(() => service.get("w")?.state === "working");
    const again = await service.stop("w", { call: "s1" });
    expect(again.kind).toBe("agent");
    expect(service.get("w")?.state).toBe("working");
    expect(service.get("w")?.closed).toBe(false);

    // Nor that of a newer agent with the name.
    await service.stop("w");
    const next = await service.spawn(agent("w", "hold this"));
    await until(() => service.get("w")?.state === "working");
    const old = await service.stop("w", { call: "s1" });
    expect(old.info.id).not.toBe(next.id);
    expect(service.get("w")?.id).toBe(next.id);
    expect(service.get("w")?.state).toBe("working");
  });

  test("a repeated graph stop leaves its agents' newer work", async () => {
    const service = await gated();
    await service.spawnGraph(pair);
    await service.wait(["g"]);
    await service.stop("g", { call: "s1" });
    await service.prompt("x", "hold here", "auto");
    await until(() => service.get("x")?.state === "working");
    const again = await service.stop("g", { call: "s1" });
    expect(again.kind).toBe("graph");
    expect(service.get("x")?.state).toBe("working");
  });

  test("calls without a key act every time", async () => {
    const { service, prompts } = await open();
    await service.spawn(agent("a", "task"));
    await service.wait(["a"]);
    await service.send("a", "more", "auto");
    await service.wait(["a"]);
    await service.send("a", "more", "auto");
    await service.wait(["a"]);
    expect(prompts).toEqual(["task", "more", "more"]);
  });
});
