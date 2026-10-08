import { afterEach, describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import type {
  GroupDelivery,
  PendingDelivery,
  SpawnSpec,
} from "../../src/agents/types.js";
import {
  jsonlStorage,
  lastUserText,
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

async function reopen(
  service: AgentService,
  options: Parameters<typeof openService>[0],
): Promise<AgentService> {
  await service.close();
  services = services.filter((each) => each !== service);
  return open(options);
}

interface Request {
  prompt: string;
  /** User messages in the request that carry exactly this prompt. */
  copies: number;
}

/**
 * A faux model that fails prompts containing "fail", answers prompts
 * containing "slow" (unless `slow` is false) or "medium" at length, and
 * answers others at once.
 */
function scripted(options: { slow?: boolean } = {}) {
  const faux = fauxProvider({ tokensPerSecond: 40 });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Request[] = [];
  const step: FauxResponseStep = (context) => {
    const prompt = lastUserText(context);
    const copies = context.messages.filter(
      (message) =>
        message.role === "user" &&
        (typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("")) === prompt,
    ).length;
    requests.push({ prompt, copies });
    if (prompt.includes("fail"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `cannot ${prompt}`,
      });
    if (prompt.includes("slow") && options.slow !== false)
      return fauxAssistantMessage(`${prompt} `.repeat(400));
    if (prompt.includes("medium"))
      return fauxAssistantMessage(`${prompt} `.repeat(20));
    return fauxAssistantMessage(`done: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return { models, requests };
}

function agents(...tasks: string[]): SpawnSpec[] {
  return tasks.map((task) => ({ task, cwd: ".", model: MODEL }));
}

function groupDelivery(deliveries: PendingDelivery[]): GroupDelivery {
  const found = deliveries.find(
    (delivery): delivery is GroupDelivery => delivery.kind === "group",
  );
  if (!found) throw new Error("no group delivery");
  return found;
}

function summary(delivery: GroupDelivery): string[] {
  return delivery.members.map((member) => {
    const outcome = member.outcome;
    if (outcome.kind === "answered")
      return `${member.name}: ${outcome.result.text}`;
    if (outcome.kind === "failed")
      return `${member.name}: failed ${outcome.reason}`;
    return `${member.name}: ${outcome.kind}`;
  });
}

describe("groups", () => {
  test("allSettled reports answers and failures together", async () => {
    const service = await open({ models: scripted().models });
    const group = await service.spawnGroup({
      name: "review",
      agents: agents("map the API", "fail the docs", "check the tests"),
    });
    expect(group.state).toBe("working");
    // Agents work from the start, before their turns send the tasks.
    expect(
      group.members.map((member) => service.get(member.agentId)?.state),
    ).toEqual(["working", "working", "working"]);
    expect(group.members.map((member) => member.name)).toEqual([
      "review-1",
      "review-2",
      "review-3",
    ]);
    expect(service.get("review-1")?.group).toBe(group.id);

    await until(() => service.pendingDeliveries().length > 0);
    expect(
      group.members.map((member) => service.get(member.agentId)?.state),
    ).toEqual(["idle", "failed", "idle"]);
    const deliveries = service.pendingDeliveries();
    // One message for the whole group, none per agent.
    expect(deliveries).toHaveLength(1);
    expect(summary(groupDelivery(deliveries))).toEqual([
      "review-1: done: map the API",
      "review-2: failed cannot fail the docs",
      "review-3: done: check the tests",
    ]);
    expect(service.getGroup("review")?.state).toBe("failed");

    await service.acknowledge(groupDelivery(deliveries));
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.groups()).toEqual([]);
    expect(service.getGroup("review")?.closed).toBe(true);
    // Failed agents stay open, like standalone ones.
    expect(service.list().map((agent) => agent.name)).toEqual(["review-2"]);
    expect(await service.liveTasks()).toEqual([]);
  });

  test("failFast stops the other agents when one fails", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({
      name: "race",
      failFast: true,
      agents: agents("slow one", "fail two", "slow three"),
    });
    await until(() => service.pendingDeliveries().length > 0);
    const delivery = groupDelivery(service.pendingDeliveries());
    expect(summary(delivery)).toEqual([
      "race-1: stopped",
      "race-2: failed cannot fail two",
      "race-3: stopped",
    ]);
    expect(service.get("race-1")?.state).toBe("interrupted");
    expect(service.get("race-3")?.state).toBe("interrupted");

    await service.acknowledge(delivery);
    // The group stopped race-1 and race-3, so they close with it.
    expect(service.list().map((agent) => agent.name)).toEqual(["race-2"]);
  });

  test("failFast keeps working when the user interrupts one agent", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({
      name: "pair",
      failFast: true,
      agents: agents("slow one", "two"),
    });
    await until(() => service.get("pair-1")?.state === "working");
    await service.interrupt("pair-1");
    await until(() => service.pendingDeliveries().length > 0);
    expect(summary(groupDelivery(service.pendingDeliveries()))).toEqual([
      "pair-1: interrupted",
      "pair-2: done: two",
    ]);
    expect(service.getGroup("pair")?.state).toBe("interrupted");
  });

  test("stopping a group stops its agents bottom-up", async () => {
    const service = await open({ models: scripted().models });
    const group = await service.spawnGroup({
      name: "slow",
      agents: agents("slow one", "slow two"),
    });
    await until(() =>
      group.members.every(
        (member) => service.get(member.agentId)?.state === "working",
      ),
    );
    // The ownership tree: a background group task owns the turns, and each
    // turn owns its agent's conversation.
    const tasks = await service.liveTasks();
    const groupNode = tasks.find((task) => task.id === group.id);
    expect(groupNode).toMatchObject({
      kind: "pi-agents.group",
      background: true,
      status: "waiting",
    });
    expect(groupNode?.owner).toBeUndefined();
    const turns = tasks.filter((task) => task.owner === group.id);
    expect(turns.map((task) => task.kind)).toEqual([
      "pi-agents.turn",
      "pi-agents.turn",
    ]);
    expect(turns.flatMap((task) => task.conversations)).toEqual(
      group.members.map((member) => member.agentId),
    );

    const stopped = await service.stop("slow");
    expect(stopped.kind).toBe("group");
    const info = service.getGroup("slow");
    expect(info?.state).toBe("interrupted");
    expect(info?.stopped).toBe(true);
    expect(info?.closed).toBe(true);
    expect(info?.members.map((member) => member.outcome?.kind)).toEqual([
      "stopped",
      "stopped",
    ]);
    for (const member of group.members) {
      const agent = service.get(member.agentId);
      expect(agent?.state).toBe("interrupted");
      expect(agent?.closed).toBe(true);
    }
    expect(await service.liveTasks()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.groups()).toEqual([]);
  });

  test("waiting for a group consumes its result", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({ name: "g", agents: agents("a", "b") });
    const outcome = await service.wait(["g"]);
    expect(outcome.timedOut).toEqual([]);
    expect(outcome.groups.map((group) => group.state)).toEqual(["idle"]);
    expect(
      outcome.groups[0]?.members.map((member) => member.outcome?.kind),
    ).toEqual(["answered", "answered"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.groups()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("a wait on a group agent covers its task", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({ name: "g", agents: agents("a", "b") });
    const outcome = await service.wait(["g-2"]);
    expect(outcome.agents.map((agent) => agent.result?.text)).toEqual([
      "done: b",
    ]);
  });

  test("a wait on a working group times out without consuming it", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({ name: "g", agents: agents("slow a", "b") });
    const outcome = await service.wait(["g"], { timeoutMs: 100 });
    expect(outcome.timedOut).toEqual(["g"]);
    expect(outcome.groups[0]?.state).toBe("working");
    await service.stop("g");
  });

  test("group agents stay attachable and answer messages after the group", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({ name: "g", agents: agents("a", "b") });
    await service.wait(["g"]);
    expect(service.get("g-1")?.closed).toBe(true);

    const view = await service.view("g-1");
    expect(view.value).toBeDefined();
    view.dispose();

    await service.send("g-1", "again", "auto");
    expect(service.get("g-1")?.closed).toBe(false);
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    expect(delivery?.kind).toBe("agent");
    if (delivery?.kind === "agent" && delivery.outcome.kind === "answered")
      expect(delivery.outcome.result.text).toBe("done: again");
    if (delivery) await service.acknowledge(delivery);
    expect(service.get("g-1")?.closed).toBe(true);

    await service.prompt("g-2", "hello", "auto");
    await until(
      () => service.get("g-2")?.result?.text === "done: [user] hello",
    );
    expect(service.getGroup("g")?.closed).toBe(true);
    expect(await service.liveTasks()).toEqual([]);
  });

  test("a message to a working group agent delivers after the group", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGroup({ name: "g", agents: agents("medium a", "b") });
    await until(() => service.get("g-1")?.state === "working");
    await service.send("g-1", "steer here", "auto");
    await until(() => service.pendingDeliveries().length > 0);
    const deliveries = service.pendingDeliveries();
    expect(deliveries.map((delivery) => delivery.kind)).toEqual(["group"]);
    await service.acknowledge(groupDelivery(deliveries));
    await until(() => service.pendingDeliveries().length === 1);
    const [delivery] = service.pendingDeliveries();
    expect(delivery?.kind).toBe("agent");
    if (delivery?.kind === "agent" && delivery.outcome.kind === "answered")
      expect(delivery.outcome.result.text).toBe("done: steer here");
  });

  test("names are shared with agents and validated up front", async () => {
    const service = await open({ models: scripted().models });
    await service.spawn({ task: "x", name: "taken", cwd: ".", model: MODEL });
    await expect(
      service.spawnGroup({ name: "taken", agents: agents("a", "b") }),
    ).rejects.toThrow("already exists");
    await expect(
      service.spawnGroup({
        agents: [
          { task: "a", name: "same", cwd: ".", model: MODEL },
          { task: "b", name: "same", cwd: ".", model: MODEL },
        ],
      }),
    ).rejects.toThrow("already exists");
    await expect(service.spawnGroup({ agents: agents("a") })).rejects.toThrow(
      "2 to 8 agents",
    );
    await expect(
      service.spawnGroup({
        agents: [
          { task: "a", cwd: ".", model: MODEL },
          { task: "b", cwd: ".", model: MODEL, tools: ["nope"] },
        ],
      }),
    ).rejects.toThrow("Unknown tools: nope");
    // Nothing was created by the failed attempts.
    expect(service.groups()).toEqual([]);

    const group = await service.spawnGroup({ agents: agents("a", "b") });
    expect(group.name).toBe("group");
    await expect(
      service.spawn({ task: "x", name: "group", cwd: ".", model: MODEL }),
    ).rejects.toThrow("already exists");
    await expect(service.send("group", "hi", "auto")).rejects.toThrow(
      "group is a group. Message its agents instead: group-1, group-2",
    );
    expect(service.find("group")?.kind).toBe("group");
    expect(service.find("group-1")?.kind).toBe("agent");
  });
});

describe("group durability", () => {
  test("a restart mid-group repeats no finished turn and delivers once", async () => {
    const directory = tempDir();
    const first = scripted();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: first.models,
    });
    await before.spawnGroup({ name: "g", agents: agents("quick", "slow") });
    await until(
      () =>
        before.getGroup("g")?.members[0]?.outcome?.kind === "answered" &&
        before.get("g-2")?.state === "working",
    );
    expect(before.getGroup("g")?.state).toBe("working");

    const second = scripted({ slow: false });
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: second.models,
    });
    await until(() => after.pendingDeliveries().length > 0);
    const deliveries = after.pendingDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(summary(groupDelivery(deliveries))).toEqual([
      "g-1: done: quick",
      "g-2: done: slow",
    ]);
    // The finished turn did not run again, and the interrupted one resumed
    // its single submission instead of sending the task again.
    expect(first.requests.filter((r) => r.prompt === "quick")).toHaveLength(1);
    expect(second.requests.map((request) => request.prompt)).toEqual(["slow"]);
    expect(second.requests[0]?.copies).toBe(1);
    await after.acknowledge(groupDelivery(deliveries));

    const third = scripted();
    const last = await reopen(after, {
      storage: await jsonlStorage(directory),
      models: third.models,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(last.pendingDeliveries()).toEqual([]);
    expect(last.getGroup("g")?.state).toBe("idle");
    expect(last.getGroup("g")?.closed).toBe(true);
    expect(third.requests).toEqual([]);
    expect(await last.liveTasks()).toEqual([]);
  });

  test("a restart between posting and acknowledging delivers again", async () => {
    const directory = tempDir();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: scripted().models,
    });
    await before.spawnGroup({ name: "g", agents: agents("a", "b") });
    await until(() => before.pendingDeliveries().length > 0);
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: scripted().models,
    });
    await until(() => after.pendingDeliveries().length > 0);
    expect(after.pendingDeliveries().map((delivery) => delivery.kind)).toEqual([
      "group",
    ]);
  });
});
