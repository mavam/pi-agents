import { afterEach, describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import type {
  GraphAgentSpec,
  GraphDelivery,
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
    // The task is the first line; the results of inputs follow it.
    const task = prompt.split("\n")[0] ?? "";
    if (task.includes("fail"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `cannot ${task}`,
      });
    if (task.includes("slow") && options.slow !== false)
      return fauxAssistantMessage(`${task} `.repeat(400));
    if (task.includes("medium"))
      return fauxAssistantMessage(`${task} `.repeat(20));
    return fauxAssistantMessage(`done: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return { models, requests };
}

function agents(...tasks: string[]): SpawnSpec[] {
  return tasks.map((task) => ({ task, cwd: ".", model: MODEL }));
}

function node(name: string, task: string, after?: string[]): GraphAgentSpec {
  return { name, task, cwd: ".", model: MODEL, ...(after ? { after } : {}) };
}

function graphDelivery(deliveries: PendingDelivery[]): GraphDelivery {
  const found = deliveries.find(
    (delivery): delivery is GraphDelivery => delivery.kind === "graph",
  );
  if (!found) throw new Error("no graph delivery");
  return found;
}

function summary(delivery: GraphDelivery): string[] {
  return delivery.nodes.map((node) => {
    const outcome = node.outcome;
    if (outcome.kind === "answered")
      return `${node.name}: ${outcome.result.text}`;
    if (outcome.kind === "failed")
      return `${node.name}: failed ${outcome.reason}`;
    return `${node.name}: ${outcome.kind}`;
  });
}

describe("graphs", () => {
  test("allSettled reports answers and failures together", async () => {
    const service = await open({ models: scripted().models });
    const graph = await service.spawnGraph({
      name: "review",
      agents: agents("map the API", "fail the docs", "check the tests"),
    });
    expect(graph.state).toBe("working");
    // Agents work from the start, before their nodes send the tasks.
    expect(graph.nodes.map((node) => service.get(node.agentId)?.state)).toEqual(
      ["working", "working", "working"],
    );
    expect(graph.nodes.map((node) => node.name)).toEqual([
      "review-1",
      "review-2",
      "review-3",
    ]);
    expect(service.get("review-1")?.graph).toBe(graph.id);

    await until(() => service.pendingDeliveries().length > 0);
    expect(graph.nodes.map((node) => service.get(node.agentId)?.state)).toEqual(
      ["idle", "failed", "idle"],
    );
    const deliveries = service.pendingDeliveries();
    // One message for the whole graph, none per agent.
    expect(deliveries).toHaveLength(1);
    expect(summary(graphDelivery(deliveries))).toEqual([
      "review-1: done: map the API",
      "review-2: failed cannot fail the docs",
      "review-3: done: check the tests",
    ]);
    expect(service.getGraph("review")?.state).toBe("failed");
    expect(service.getGraph("review")?.queued).toBe(true);

    await service.acknowledge(graphDelivery(deliveries));
    expect(service.getGraph("review")?.queued).toBeUndefined();
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.graphs()).toEqual([]);
    expect(service.getGraph("review")?.closed).toBe(true);
    // Failed agents stay open, like standalone ones.
    expect(service.list().map((agent) => agent.name)).toEqual(["review-2"]);
    expect(await service.liveTasks()).toEqual([]);
  });

  test("failFast stops the other agents when one fails", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "race",
      failFast: true,
      agents: agents("slow one", "fail two", "slow three"),
    });
    await until(() => service.pendingDeliveries().length > 0);
    const delivery = graphDelivery(service.pendingDeliveries());
    expect(summary(delivery)).toEqual([
      "race-1: stopped",
      "race-2: failed cannot fail two",
      "race-3: stopped",
    ]);
    expect(service.get("race-1")?.state).toBe("interrupted");
    expect(service.get("race-3")?.state).toBe("interrupted");

    await service.acknowledge(delivery);
    // The graph stopped race-1 and race-3, so they close with it.
    expect(service.list().map((agent) => agent.name)).toEqual(["race-2"]);
  });

  test("failFast keeps working when the user interrupts one agent", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "pair",
      failFast: true,
      agents: agents("slow one", "two"),
    });
    await until(() => service.get("pair-1")?.state === "working");
    await service.interrupt("pair-1");
    await until(() => service.pendingDeliveries().length > 0);
    expect(summary(graphDelivery(service.pendingDeliveries()))).toEqual([
      "pair-1: interrupted",
      "pair-2: done: two",
    ]);
    expect(service.getGraph("pair")?.state).toBe("interrupted");
  });

  test("stopping a graph stops its agents bottom-up", async () => {
    const service = await open({ models: scripted().models });
    const graph = await service.spawnGraph({
      name: "slow",
      agents: agents("slow one", "slow two"),
    });
    await until(() =>
      graph.nodes.every(
        (node) => service.get(node.agentId)?.state === "working",
      ),
    );
    // The ownership tree: a background graph task owns the nodes, and each
    // turn owns its agent's conversation.
    const tasks = await service.liveTasks();
    const graphNode = tasks.find((task) => task.id === graph.id);
    expect(graphNode).toMatchObject({
      kind: "pi-agents.graph",
      background: true,
      status: "waiting",
    });
    expect(graphNode?.owner).toBeUndefined();
    const nodes = tasks.filter((task) => task.owner === graph.id);
    expect(nodes.map((task) => task.kind)).toEqual([
      "pi-agents.node",
      "pi-agents.node",
    ]);
    expect(nodes.flatMap((task) => task.conversations)).toEqual(
      graph.nodes.map((node) => node.agentId),
    );

    const stopped = await service.stop("slow");
    expect(stopped.kind).toBe("graph");
    const info = service.getGraph("slow");
    expect(info?.state).toBe("interrupted");
    expect(info?.stopped).toBe(true);
    expect(info?.closed).toBe(true);
    expect(info?.nodes.map((node) => node.outcome?.kind)).toEqual([
      "stopped",
      "stopped",
    ]);
    for (const node of graph.nodes) {
      const agent = service.get(node.agentId);
      expect(agent?.state).toBe("interrupted");
      expect(agent?.closed).toBe(true);
    }
    expect(await service.liveTasks()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.graphs()).toEqual([]);
  });

  test("waiting for a graph consumes its result", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({ name: "g", agents: agents("a", "b") });
    const outcome = await service.wait(["g"]);
    expect(outcome.timedOut).toEqual([]);
    expect(outcome.graphs.map((graph) => graph.state)).toEqual(["idle"]);
    expect(outcome.graphs[0]?.nodes.map((node) => node.outcome?.kind)).toEqual([
      "answered",
      "answered",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.graphs()).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("a wait on a graph agent covers its task", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({ name: "g", agents: agents("a", "b") });
    const outcome = await service.wait(["g-2"]);
    expect(outcome.agents.map((agent) => agent.result?.text)).toEqual([
      "done: b",
    ]);
  });

  test("a wait on a working graph times out without consuming it", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({ name: "g", agents: agents("slow a", "b") });
    const outcome = await service.wait(["g"], { timeoutMs: 100 });
    expect(outcome.timedOut).toEqual(["g"]);
    expect(outcome.graphs[0]?.state).toBe("working");
    await service.stop("g");
  });

  test("graph agents stay attachable and answer messages after the graph", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({ name: "g", agents: agents("a", "b") });
    await service.wait(["g"]);
    expect(service.get("g-1")?.closed).toBe(true);

    const view = await service.view("g-1");
    expect(view.value).toBeDefined();
    view.dispose();

    // A graph's agent knows its task's answer, too.
    const answered = service.getGraph("g")?.nodes[0]?.outcome;
    expect(answered?.kind).toBe("answered");
    if (answered?.kind === "answered")
      expect(service.get("g-1")?.taskAnswer).toBe(answered.result.entryId);
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
    expect(service.getGraph("g")?.closed).toBe(true);
    expect(await service.liveTasks()).toEqual([]);
  });

  test("a message to a working graph agent delivers after the graph", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({ name: "g", agents: agents("medium a", "b") });
    await until(() => service.get("g-1")?.state === "working");
    await service.send("g-1", "steer here", "auto");
    await until(() => service.pendingDeliveries().length > 0);
    const deliveries = service.pendingDeliveries();
    expect(deliveries.map((delivery) => delivery.kind)).toEqual(["graph"]);
    await service.acknowledge(graphDelivery(deliveries));
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
      service.spawnGraph({ name: "taken", agents: agents("a", "b") }),
    ).rejects.toThrow("already exists");
    await expect(
      service.spawnGraph({
        agents: [
          { task: "a", name: "same", cwd: ".", model: MODEL },
          { task: "b", name: "same", cwd: ".", model: MODEL },
        ],
      }),
    ).rejects.toThrow("already exists");
    await expect(service.spawnGraph({ agents: agents("a") })).rejects.toThrow(
      "2 to 12 agents",
    );
    await expect(
      service.spawnGraph({
        agents: [
          { task: "a", cwd: ".", model: MODEL },
          { task: "b", cwd: ".", model: MODEL, tools: ["nope"] },
        ],
      }),
    ).rejects.toThrow("Unknown tools: nope");
    // Nothing was created by the failed attempts.
    expect(service.graphs()).toEqual([]);

    const graph = await service.spawnGraph({ agents: agents("a", "b") });
    expect(graph.name).toBe("graph");
    await expect(
      service.spawn({ task: "x", name: "graph", cwd: ".", model: MODEL }),
    ).rejects.toThrow("already exists");
    await expect(service.send("graph", "hi", "auto")).rejects.toThrow(
      "graph is a graph. Message its agents instead: graph-1, graph-2",
    );
    expect(service.find("graph")?.kind).toBe("graph");
    expect(service.find("graph-1")?.kind).toBe("agent");
  });
});

describe("graph edges", () => {
  test("a pipeline passes each result to the next agent", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "ship",
      agents: [
        node("build", "build it", ["plan"]),
        node("plan", "medium plan it"),
      ],
    });
    // build waits for plan, whatever their order.
    await until(() => service.get("plan")?.state === "working");
    expect(service.get("build")?.state).toBe("waiting");
    expect(service.getGraph("ship")?.nodes.map((each) => each.name)).toEqual([
      "plan",
      "build",
    ]);

    await until(() => service.pendingDeliveries().length > 0);
    const delivery = graphDelivery(service.pendingDeliveries());
    const build = delivery.nodes.find((each) => each.name === "build");
    expect(build?.end).toBe(true);
    expect(delivery.nodes.find((each) => each.name === "plan")?.end).toBe(
      false,
    );
    expect(build?.outcome.kind).toBe("answered");
    if (build?.outcome.kind === "answered") {
      const text = build.outcome.result.text;
      expect(text).toStartWith("done: build it");
      expect(text).toContain("## Results of other agents");
      expect(text).toContain("### plan");
      expect(text).toContain("medium plan it");
    }
  });

  test("a merge runs with the inputs that answered and notes the rest", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "review",
      agents: [
        node("api", "map the API"),
        node("tests", "fail the tests"),
        node("merge", "merge findings", ["api", "tests"]),
      ],
    });
    await until(() => service.pendingDeliveries().length > 0);
    const delivery = graphDelivery(service.pendingDeliveries());
    expect(summary(delivery)).toEqual([
      "api: done: map the API",
      "tests: failed cannot fail the tests",
      expect.stringContaining("merge: done: merge findings"),
    ]);
    const merge = delivery.nodes.find((each) => each.name === "merge");
    if (merge?.outcome.kind === "answered")
      expect(merge.outcome.result.text).toContain(
        "(No result: failed: cannot fail the tests.)",
      );
    // The graph's result is the merge's, so a failed input doesn't fail it.
    expect(service.getGraph("review")?.state).toBe("idle");
  });

  test("an agent whose inputs all failed is skipped", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "chain",
      agents: [node("first", "fail first"), node("second", "go", ["first"])],
    });
    await until(() => service.pendingDeliveries().length > 0);
    const delivery = graphDelivery(service.pendingDeliveries());
    expect(summary(delivery)).toEqual([
      "first: failed cannot fail first",
      "second: skipped",
    ]);
    expect(service.get("second")?.state).toBe("skipped");
    expect(service.getGraph("chain")?.state).toBe("failed");
    await service.acknowledge(delivery);
    // Skipped agents never ran, so they close; the failed one stays.
    expect(service.list().map((agent) => agent.name)).toEqual(["first"]);
  });

  test("failFast stops agents that wait for their inputs", async () => {
    const service = await open({ models: scripted().models });
    await service.spawnGraph({
      name: "race",
      failFast: true,
      agents: [
        node("slow", "slow one"),
        node("bad", "fail two"),
        node("after", "three", ["slow"]),
      ],
    });
    await until(() => service.pendingDeliveries().length > 0);
    expect(summary(graphDelivery(service.pendingDeliveries()))).toEqual([
      "slow: stopped",
      "bad: failed cannot fail two",
      "after: stopped",
    ]);
    expect(service.get("after")?.state).toBe("interrupted");
  });

  test("edges must name agents of the graph and form no cycle", async () => {
    const service = await open({ models: scripted().models });
    await expect(
      service.spawnGraph({
        agents: [node("a", "x"), node("b", "y", ["c"])],
      }),
    ).rejects.toThrow("b waits for c, which is not an agent of this graph");
    await expect(
      service.spawnGraph({
        agents: [node("a", "x"), node("b", "y", ["b"])],
      }),
    ).rejects.toThrow("b cannot wait for itself");
    await expect(
      service.spawnGraph({
        agents: [node("a", "x", ["b"]), node("b", "y", ["a"])],
      }),
    ).rejects.toThrow("The agents wait for each other in a cycle: a → b → a");
    expect(service.graphs()).toEqual([]);
    expect(service.list()).toEqual([]);
  });
});

describe("graphs that hold their result", () => {
  /** A graph whose quick agent works on a user's message after answering,
   * so the graph holds its result once the slow agent answered. */
  async function held(service: AgentService) {
    await service.spawnGraph({
      name: "g",
      agents: [node("quick", "a"), node("other", "medium b")],
    });
    await until(
      () => service.getGraph("g")?.nodes[0]?.outcome?.kind === "answered",
    );
    await service.prompt("quick", "slow again", "auto");
    await until(async () =>
      (await service.liveTasks()).some(
        (task) =>
          task.kind === "pi-agents.graph" && task.status === "completing",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  test("a graph works until its agents' work drained", async () => {
    const service = await open({ models: scripted().models });
    await held(service);
    // Both agents answered their tasks, but the graph still works.
    expect(service.getGraph("g")?.state).toBe("working");
    expect(service.get("quick")?.state).toBe("working");
    expect(service.pendingDeliveries()).toEqual([]);

    await service.interrupt("quick");
    await until(() => service.pendingDeliveries().length > 0);
    expect(summary(graphDelivery(service.pendingDeliveries()))).toEqual([
      "quick: done: a",
      expect.stringContaining("other: medium b"),
    ]);
    expect(service.getGraph("g")?.state).toBe("idle");
  });

  test("stopping a graph that holds its result stops it", async () => {
    const service = await open({ models: scripted().models });
    await held(service);
    const stopped = await service.stop("g");
    expect(stopped.kind).toBe("graph");
    const graph = service.getGraph("g");
    expect(graph?.stopped).toBe(true);
    expect(graph?.state).toBe("interrupted");
    expect(service.get("quick")?.state).toBe("interrupted");
    expect(await service.liveTasks()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });
});

describe("graph durability", () => {
  test("a restart mid-graph repeats no finished node and delivers once", async () => {
    const directory = tempDir();
    const first = scripted();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: first.models,
    });
    await before.spawnGraph({ name: "g", agents: agents("quick", "slow") });
    await until(
      () =>
        before.getGraph("g")?.nodes[0]?.outcome?.kind === "answered" &&
        before.get("g-2")?.state === "working",
    );
    expect(before.getGraph("g")?.state).toBe("working");

    const second = scripted({ slow: false });
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: second.models,
    });
    await until(() => after.pendingDeliveries().length > 0);
    const deliveries = after.pendingDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(summary(graphDelivery(deliveries))).toEqual([
      "g-1: done: quick",
      "g-2: done: slow",
    ]);
    // The finished turn did not run again, and the interrupted one resumed
    // its single submission instead of sending the task again.
    expect(first.requests.filter((r) => r.prompt === "quick")).toHaveLength(1);
    expect(second.requests.map((request) => request.prompt)).toEqual(["slow"]);
    expect(second.requests[0]?.copies).toBe(1);
    await after.acknowledge(graphDelivery(deliveries));

    const third = scripted();
    const last = await reopen(after, {
      storage: await jsonlStorage(directory),
      models: third.models,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(last.pendingDeliveries()).toEqual([]);
    expect(last.getGraph("g")?.state).toBe("idle");
    expect(last.getGraph("g")?.closed).toBe(true);
    expect(third.requests).toEqual([]);
    expect(await last.liveTasks()).toEqual([]);
  });

  test("a restart mid-pipeline repeats no finished agent and sends once", async () => {
    const directory = tempDir();
    const first = scripted();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: first.models,
    });
    await before.spawnGraph({
      name: "p",
      agents: [node("plan", "plan"), node("build", "slow build", ["plan"])],
    });
    await until(() => before.get("build")?.state === "working");
    await until(() =>
      first.requests.some((request) => request.prompt.startsWith("slow build")),
    );

    const second = scripted({ slow: false });
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: second.models,
    });
    await until(() => after.pendingDeliveries().length > 0);
    const delivery = graphDelivery(after.pendingDeliveries());
    expect(delivery.nodes.map((each) => each.outcome.kind)).toEqual([
      "answered",
      "answered",
    ]);
    expect(first.requests.filter((r) => r.prompt === "plan")).toHaveLength(1);
    // Only build's interrupted answer ran again, with its message once.
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.prompt).toStartWith("slow build");
    expect(second.requests[0]?.copies).toBe(1);
  });

  test("a restart between posting and acknowledging delivers again", async () => {
    const directory = tempDir();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: scripted().models,
    });
    await before.spawnGraph({ name: "g", agents: agents("a", "b") });
    await until(() => before.pendingDeliveries().length > 0);
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: scripted().models,
    });
    await until(() => after.pendingDeliveries().length > 0);
    expect(after.pendingDeliveries().map((delivery) => delivery.kind)).toEqual([
      "graph",
    ]);
  });
});
