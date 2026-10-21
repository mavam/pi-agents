import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { GraphsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import type { SpawningLimits } from "../../src/agents/spawn-support.js";
import type { GraphDelivery } from "../../src/agents/types.js";
import {
  closeService,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

/**
 * A faux model for agents that spawn. A job `spawn <json>` calls
 * agent_spawn with that JSON; after its result, the agent answers
 * `checking`, or with `wait` in the job, calls agent_wait. A job
 * `script <code>` runs codemode. Results that arrive as input or from
 * other tools, and failed calls, are answered `final: <first line>`. Jobs
 * with `hold` work until aborted (unless `hold` is false); others answer
 * `done: <first line>`. `prompts` collects the first lines of inputs.
 */
function scripted(options: { hold?: boolean } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  const step: FauxResponseStep = async (context, request) => {
    const messages = context.messages.filter((each) => each.role !== "system");
    const last = messages.at(-1);
    const job = textOf(messages.find((each) => each.role === "user")?.content);
    const text = textOf(last?.content);
    if (last?.role === "toolResult") {
      if (last.toolName === "agent_spawn" && !last.isError)
        return job.includes(" wait")
          ? fauxAssistantMessage([fauxToolCall("agent_wait", {})], {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage([fauxText("checking")]);
      return fauxAssistantMessage([fauxText(`final: ${text.split("\n")[0]}`)]);
    }
    const first = text.split("\n")[0] ?? "";
    prompts.push(first);
    if (first.startsWith("[results] "))
      return fauxAssistantMessage(`final: ${first}`);
    if (first.startsWith("spawn ")) {
      const json = first.slice(6).replace(/ wait$/, "");
      return fauxAssistantMessage(
        [fauxToolCall("agent_spawn", JSON.parse(json))],
        { stopReason: "toolUse" },
      );
    }
    if (first.startsWith("script "))
      return fauxAssistantMessage(
        [fauxToolCall("codemode", { code: first.slice(7) })],
        { stopReason: "toolUse" },
      );
    if (first.includes("hold") && options.hold !== false) {
      await heldUntilAborted(request?.signal);
      return fauxAssistantMessage(first);
    }
    return fauxAssistantMessage(`done: ${first}`);
  };
  faux.setResponses(Array.from({ length: 300 }, () => step));
  return { models, prompts };
}

async function open(
  options: {
    maxWorkingAgents?: number;
    storage?: Storage;
    models?: ReturnType<typeof scripted>["models"];
    spawningLimits?: Partial<SpawningLimits>;
  } = {},
): Promise<AgentService> {
  const service = await openService({
    ...options,
    models: options.models ?? scripted().models,
  });
  services.push(service);
  return service;
}

async function reopen(
  service: AgentService,
  options: Parameters<typeof open>[0],
): Promise<AgentService> {
  await closeService(service);
  services = services.filter((each) => each !== service);
  return open(options);
}

function spawnJob(agents: unknown[], wait = false): string {
  return `spawn ${JSON.stringify({ agents })}${wait ? " wait" : ""}`;
}

function lead(job: string, extra: Record<string, unknown> = {}) {
  return { name: "lead", job, spawn: true, cwd: ".", model: MODEL, ...extra };
}

/** The groups agents spawned, as opposed to the parent's graphs. */
function spawnedGroups(service: AgentService) {
  return service
    .graphs({ includeClosed: true, includeSingle: true })
    .filter((each) => each.owner !== undefined);
}

/** An agent's transcript entries. */
async function entries(service: AgentService, name: string) {
  const id = Number(service.get(name)?.id) as ConversationId;
  const conversation = await hostOf(service).harness.harness.conversation(
    id,
    CONTEXT,
  );
  const page = await conversation?.entries({}, 200, undefined, CONTEXT);
  return page?.items ?? [];
}

/** The parent's result of the graph `name`, once it arrived. */
async function resultOf(
  service: AgentService,
  name: string,
): Promise<GraphDelivery> {
  let found: GraphDelivery | undefined;
  await until(() => {
    found = service
      .pendingDeliveries()
      .find(
        (each): each is GraphDelivery =>
          each.kind === "graph" && each.name === name,
      );
    return found !== undefined;
  }, 10_000);
  return found as GraphDelivery;
}

function answerOf(delivery: GraphDelivery): string {
  const [node] = delivery.nodes;
  return node?.outcome.kind === "answered" ? node.outcome.result.text : "";
}

describe("spawning", () => {
  test("an agent's answer before its agents' results doesn't end its job", async () => {
    const service = await open();
    const graph = await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "scout", job: "look around" }]))],
    });
    expect(graph.single).toBe(true);
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toBe("final: [results] scout answered:");
    const nested = service
      .graphs({ includeClosed: true, includeSingle: true })
      .find((each) => each.owner !== undefined);
    expect(nested?.nodes.map((node) => node.name)).toEqual(["lead.scout"]);
    expect(service.get("lead.scout")?.owner).toBe(graph.nodes[0]?.agentId);
  });

  test("a parent's message settles with the answer after the results it asked for", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [lead("idle")] });
    const first = await resultOf(service, "lead");
    await service.acknowledge(first);
    await service.send("lead", spawnJob([{ name: "s", job: "look" }]), "steer");
    const outcome = await service.wait(["lead"]);
    expect(outcome.agents[0]?.result?.text).toBe(
      "final: [results] s answered:",
    );
  });

  test("agents nest three deep under a cap of one working agent", async () => {
    const service = await open({ maxWorkingAgents: 1 });
    const leaf = { name: "leaf", job: "dig" };
    const middle = {
      name: "mid",
      job: spawnJob([leaf], true),
      spawn: true,
    };
    await service.spawnGraph({ agents: [lead(spawnJob([middle], true))] });
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toStartWith("final: ");
    expect(service.get("lead.mid.leaf")?.result?.text).toBe("done: dig");
  });

  test("agents at the deepest level can't spawn", async () => {
    const service = await open();
    const deep = { name: "deep", job: "dig", spawn: true };
    const middle = { name: "mid", job: spawnJob([deep]), spawn: true };
    await service.spawnGraph({ agents: [lead(spawnJob([middle]))] });
    await resultOf(service, "lead");
    expect(
      service.list({ includeClosed: true }).map((info) => info.name),
    ).toEqual(["lead", "lead.mid"]);
  });

  test("an interrupt keeps the agents an agent spawned; a stop ends them", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "slow", job: "hold on" }]))],
    });
    await until(() => service.get("lead.slow")?.state === "working", 10_000);
    await until(() => service.get("lead")?.result?.text === "checking");
    await service.interrupt("lead");
    expect(service.get("lead.slow")?.state).toBe("working");
    await service.stop("lead");
    await until(
      () => service.get("lead.slow")?.state === "interrupted",
      10_000,
    );
    const nested = service
      .graphs({ includeClosed: true, includeSingle: true })
      .find((each) => each.owner !== undefined);
    await until(() => service.graphById(nested?.id ?? "")?.state !== "working");
    expect(service.graphById(nested?.id ?? "")?.cancelled).toBe(true);
  });

  test("the parent's interrupt aborts work, drops queued messages, and keeps the job and agents", async () => {
    const { models, prompts } = scripted();
    const service = await open({ models });
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "slow", job: "hold on" }]))],
    });
    await until(() => service.get("lead")?.result?.text === "checking");
    await service.send("lead", "hold me", "steer");
    await until(() => service.get("lead")?.state === "working");
    await service.send("lead", "later", "followUp");
    const sent = await service.send("lead", "go on", "interrupt");
    expect(sent.dropped).toBe(1);
    await until(() => service.get("lead")?.result?.text === "done: go on");
    expect(prompts).not.toContain("later");
    expect(service.get("lead")?.closed).toBe(false);
    expect(service.get("lead.slow")?.state).toBe("working");
  });

  test("after an interrupt, results wait until the agent answered again", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "s", job: "hold s" }]))],
    });
    await until(() => service.get("lead")?.result?.text === "checking");
    await service.interrupt("lead");
    await service.interrupt("lead.s");
    await service.prompt("lead.s", "go on", "auto");
    await until(
      () => service.get("lead.s")?.result?.text === "done: [user] go on",
    );
    await Bun.sleep(100);
    // The interrupted lead got nothing that restarted it.
    expect(service.get("lead")?.result?.text).toBe("checking");
    await service.prompt("lead", "continue", "auto");
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toBe("final: [results] s answered:");
  });

  test("a stop reaches agents below, also through groups that finished", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "child", job: "look", spawn: true }]))],
    });
    await resultOf(service, "lead");
    await service.send(
      "lead.child",
      spawnJob([{ name: "grand", job: "hold grand" }]),
      "steer",
    );
    await until(() => service.get("lead.child.grand")?.state === "working");
    await service.stop("lead");
    await until(() => service.get("lead.child.grand")?.state !== "working");
    expect(service.get("lead.child")?.closed).toBe(true);
  });

  test("a stopped agent never gets the job it waited for", async () => {
    const service = await open();
    await service.spawnGraph({
      name: "dag",
      agents: [
        { name: "a", job: "hold a", cwd: ".", model: MODEL },
        { name: "b", job: "B job", after: ["a"], cwd: ".", model: MODEL },
      ],
    });
    await until(() => service.get("b")?.state === "waiting");
    await expect(service.prompt("b", "early", "auto")).rejects.toThrow(
      "hasn't started",
    );
    await service.stop("b");
    await service.interrupt("a");
    await service.prompt("a", "go on", "auto");
    await until(() => service.getGraph("dag")?.state !== "working", 10_000);
    expect(service.get("b")?.result).toBeUndefined();
  });

  test("agent_wait returns the results, which then don't arrive as input", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "scout", job: "look" }], true))],
    });
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toBe("final: scout answered:");
    await until(async () => (await service.liveTasks()).length === 0);
    const transcript = await entries(service, "lead");
    expect(transcript.map((entry) => entry.kind)).not.toContain(
      "pi-agents.results",
    );
    const graphs = await hostOf(service).harness.harness.snapshot(
      GraphsDoc,
      CONTEXT,
    );
    const group = Object.values(graphs?.graphs ?? {}).find(
      (each) => each.owner,
    );
    // Presentation is evidence in committed model context, not a task's
    // result or progress details (neither is visible for nested calls).
    const presented = transcript.find((entry) => entry.id === group?.presented);
    const message = presented?.model?.[0];
    expect(message?.role === "toolResult" && message.toolName).toBe(
      "agent_wait",
    );
    expect(textOf(message?.content)).toContain("done: look");
  });

  test("codemode cannot consume results without showing them to the model", async () => {
    const service = await open();
    const code = [
      'await tools.agent_spawn({ agents: [{ name: "s", job: "hold s" }] });',
      "await tools.agent_wait({});",
      'throw new Error("discarded child result");',
    ].join(" ");
    await service.spawnGraph({
      agents: [lead(`script ${code}`, { tools: ["codemode"] })],
    });
    await until(
      () =>
        service
          .get("lead")
          ?.result?.text?.startsWith("final: Script failed") === true,
    );
    expect(service.pendingDeliveries()).toEqual([]);
    const before = await entries(service, "lead");
    const failure = before
      .flatMap((entry) => entry.model ?? [])
      .find(
        (message) =>
          message.role === "toolResult" && message.toolName === "codemode",
      );
    expect(failure?.role === "toolResult" && failure.isError).toBe(true);
    expect(textOf(failure?.content)).toContain("agent_wait");
    expect(textOf(failure?.content)).not.toContain("discarded child result");
    const graphs = await hostOf(service).harness.harness.snapshot(
      GraphsDoc,
      CONTEXT,
    );
    const group = Object.values(graphs?.graphs ?? {}).find(
      (each) => each.owner,
    );
    expect(group?.claim).toBeUndefined();
    expect(group?.presented).toBeUndefined();

    await until(() => service.get("lead.s")?.state === "working");
    await service.interrupt("lead.s");
    await service.prompt("lead.s", "continue", "auto");
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toBe("final: [results] s answered:");
    const results = (await entries(service, "lead")).filter(
      (entry) => entry.kind === "pi-agents.results",
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0]?.model)).toContain(
      "done: [user] continue",
    );
  });

  test("spawned agents get only tools their spawner has", async () => {
    const service = await open();
    await service.spawnGraph({
      agents: [
        lead(spawnJob([{ name: "a", job: "a", tools: ["bash"] }]), {
          tools: ["read"],
        }),
      ],
    });
    const delivery = await resultOf(service, "lead");
    expect(answerOf(delivery)).toBe(
      "final: Agent a asks for tools you don't have: bash. Your tools: read",
    );
    expect(spawnedGroups(service)).toEqual([]);
  });

  test("finishing a child does not replenish the lifetime spawn cap", async () => {
    const service = await open({ spawningLimits: { perAgent: 1 } });
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "a", job: "a" }]))],
    });
    await service.acknowledge(await resultOf(service, "lead"));
    await service.send("lead", spawnJob([{ name: "b", job: "b" }]), "steer");
    const outcome = await service.wait(["lead"]);
    expect(outcome.agents[0]?.result?.text).toBe(
      "final: You can spawn 1 agents in total and spawned 1, so 1 more is too many.",
    );
    expect(spawnedGroups(service)).toHaveLength(1);
  });

  test("cancelled children still consume the default lifetime cap of 24", async () => {
    const service = await open();
    const job = spawnJob(
      Array.from({ length: 12 }, (_, index) => ({
        name: `child-${index}`,
        job: "hold child",
      })),
    );
    await service.spawnGraph({ agents: [lead(job)] });
    for (let batch = 1; batch <= 2; batch++) {
      await until(
        () =>
          spawnedGroups(service).length === batch &&
          service.get("lead")?.result?.text === "checking",
      );
      await service.stop("lead");
      expect(spawnedGroups(service).every((group) => group.cancelled)).toBe(
        true,
      );
      // Reopening the same agent must not reset its budget.
      await service.send("lead", job, "steer");
    }
    const outcome = await service.wait(["lead"]);
    expect(outcome.agents[0]?.result?.text).toBe(
      "final: You can spawn 24 agents in total and spawned 24, so 12 more is too many.",
    );
    expect(spawnedGroups(service)).toHaveLength(2);
  });

  test("the session caps spawned agents that work at once", async () => {
    const service = await open({ spawningLimits: { active: 1 } });
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "a", job: "hold a" }]))],
    });
    await until(() => service.get("lead.a")?.state === "working", 10_000);
    await service.spawnGraph({
      agents: [lead(spawnJob([{ name: "b", job: "b" }]), { name: "second" })],
    });
    const delivery = await resultOf(service, "second");
    expect(answerOf(delivery)).toBe(
      "final: At most 1 spawned agents can work at once in this session and 1 do. Spawn fewer, or wait for yours to finish.",
    );
  });

  test("stopping a parent's graph stops the agents its agents spawned", async () => {
    const service = await open();
    await service.spawnGraph({
      name: "top",
      agents: [
        lead(spawnJob([{ name: "a", job: "hold a" }])),
        { name: "other", job: "hold other", cwd: ".", model: MODEL },
      ],
    });
    await until(() => service.get("lead.a")?.state === "working", 10_000);
    await service.stop("top");
    await until(() => service.get("lead.a")?.state === "interrupted", 10_000);
    await until(async () => (await service.liveTasks()).length === 0, 10_000);
  });

  test("each agent_spawn of a script starts its own group", async () => {
    const service = await open();
    const call = (name: string) =>
      `tools.agent_spawn({ agents: [{ name: "${name}", job: "map ${name}" }] })`;
    const info = await service.spawnGraph({
      agents: [
        lead(
          `script return await Promise.all([${call("api")}, ${call("tests")}]);`,
          { tools: ["codemode"] },
        ),
      ],
    });
    await until(
      () =>
        spawnedGroups(service).length === 2 &&
        spawnedGroups(service).every((each) => each.state !== "working"),
      10_000,
    );
    const groups = spawnedGroups(service);
    expect(groups.map((each) => each.owner)).toEqual([
      info.nodes[0]?.agentId,
      info.nodes[0]?.agentId,
    ]);
    expect(groups.map((each) => each.nodes[0]?.name).sort()).toEqual([
      "lead.api",
      "lead.tests",
    ]);
  });
});

describe("spawning durability", () => {
  test("a restart while an agent waits starts no second group", async () => {
    const directory = tempDir();
    const first = scripted();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: first.models,
    });
    await before.spawnGraph({
      agents: [
        lead(
          spawnJob(
            [
              { name: "a", job: "a" },
              { name: "b", job: "hold b" },
            ],
            true,
          ),
        ),
      ],
    });
    await until(
      () =>
        before.get("lead.a")?.result?.text === "done: a" &&
        before.get("lead.b")?.state === "working",
      10_000,
    );
    // The lead's agent_wait holds the result.
    await until(async () => {
      const graphs = await hostOf(before).harness.harness.snapshot(
        GraphsDoc,
        CONTEXT,
      );
      return Object.values(graphs?.graphs ?? {}).some(
        (each) => each.claim !== undefined,
      );
    }, 10_000);
    const second = scripted({ hold: false });
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: second.models,
    });
    const delivery = await resultOf(after, "lead");
    expect(answerOf(delivery)).toStartWith("final: ");
    expect(spawnedGroups(after)).toHaveLength(1);
    // Only b's interrupted work ran again; a and the lead's job didn't.
    expect(second.prompts).toEqual(["hold b"]);
  });
});
