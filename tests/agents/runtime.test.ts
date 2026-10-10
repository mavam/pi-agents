import { afterEach, describe, expect, test } from "bun:test";
import type { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  createFaux,
  createGatedFaux,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "./helpers.js";

// When agents and graphs ended, which stops their clocks.

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

async function reopen(
  service: AgentService,
  options: Parameters<typeof openService>[0],
): Promise<AgentService> {
  await closeService(service);
  services = services.filter((each) => each !== service);
  return open(options);
}

function endedAt(service: AgentService, name: string): number {
  const ended = service.get(name)?.endedAt;
  if (ended === undefined) throw new Error(`${name} has no end`);
  return ended;
}

describe("runtime", () => {
  test("an agent ends when its answer streamed, also after reopening", async () => {
    const directory = tempDir();
    // About 300ms of streaming after the answer's timestamp.
    const { models } = createFaux((prompt) => `${prompt} `.repeat(60), {
      tokensPerSecond: 200,
    });
    const first = await open({
      storage: await jsonlStorage(directory),
      models,
    });
    await first.spawn({ task: "long", name: "w", cwd: ".", model: MODEL });
    await first.wait(["w"]);
    const ended = endedAt(first, "w");
    const info = first.get("w");
    expect(info?.state).toBe("idle");
    expect(ended - (info?.result?.at ?? ended)).toBeGreaterThan(100);

    const second = await reopen(first, {
      storage: await jsonlStorage(directory),
      models,
    });
    await until(() => second.get("w") !== undefined);
    expect(second.get("w")?.state).toBe("idle");
    expect(endedAt(second, "w")).toBe(ended);
  });

  test("every turn moves the end, however fast", async () => {
    const service = await open();
    await service.spawn({ task: "first", name: "w", cwd: ".", model: MODEL });
    await service.wait(["w"]);
    let previous = endedAt(service, "w");
    for (const prompt of ["second", "third", "fourth"]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.prompt("w", prompt, "auto");
      await until(
        () => service.get("w")?.result?.text === `done: [user] ${prompt}`,
      );
      await until(() => (service.get("w")?.endedAt ?? 0) > previous);
      previous = endedAt(service, "w");
    }
  });

  test("interrupted and failed agents end, also after reopening", async () => {
    const directory = tempDir();
    const { models } = createGatedFaux();
    const first = await open({
      storage: await jsonlStorage(directory),
      models,
    });
    await first.spawn({ task: "hold", name: "held", cwd: ".", model: MODEL });
    await first.spawn({ task: "fail", name: "broken", cwd: ".", model: MODEL });
    await until(() => first.get("held")?.state === "working");
    await first.interrupt("held");
    await until(
      () =>
        first.get("held")?.state === "interrupted" &&
        first.get("broken")?.state === "failed",
    );
    await until(
      () =>
        first.get("held")?.endedAt !== undefined &&
        first.get("broken")?.endedAt !== undefined,
    );
    const held = endedAt(first, "held");
    const broken = endedAt(first, "broken");

    const second = await reopen(first, {
      storage: await jsonlStorage(directory),
      models,
    });
    await until(() => second.get("broken") !== undefined);
    expect(endedAt(second, "held")).toBe(held);
    expect(endedAt(second, "broken")).toBe(broken);
  });

  test("a graph ends with its task, not with later messages", async () => {
    const directory = tempDir();
    const { models } = createFaux();
    const first = await open({
      storage: await jsonlStorage(directory),
      models,
    });
    await first.spawnGraph({
      name: "g",
      agents: [
        { task: "a", cwd: ".", model: MODEL },
        { task: "b", cwd: ".", model: MODEL },
      ],
    });
    await first.wait(["g"]);
    const graphEnd = first.getGraph("g")?.endedAt;
    expect(graphEnd).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.prompt("g-1", "again", "auto");
    await until(() => first.get("g-1")?.result?.text === "done: [user] again");
    await until(() => (first.get("g-1")?.endedAt ?? 0) > (graphEnd ?? 0));
    expect(first.getGraph("g")?.endedAt).toBe(graphEnd);

    const second = await reopen(first, {
      storage: await jsonlStorage(directory),
      models,
    });
    await until(() => second.getGraph("g") !== undefined);
    expect(second.getGraph("g")?.endedAt).toBe(graphEnd);
    expect(endedAt(second, "g-1")).toBeGreaterThan(graphEnd ?? 0);
  });
});
