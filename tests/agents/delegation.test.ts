import { afterEach, describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { DelegationLimits } from "../../src/agents/delegation.js";
import { AgentService } from "../../src/agents/service.js";
import { createPromptExtension } from "../../src/host/prompt.js";
import { createToolsExtension } from "../../src/host/tools.js";
import {
  inheritHelper,
  jsonlStorage,
  MODEL,
  tempDir,
  until,
} from "./helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await service.close();
  services = [];
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("");
}

/**
 * A faux model for leads and helpers. A message `delegate <json>` calls
 * delegate_graph with that JSON, and a tool result is answered with
 * `merged: <result>`. Other messages answer `done: <first line>`; first
 * lines with "fail" fail, and with "slow" (unless `slow` is false) answer at
 * length.
 */
function scripted(options: { slow?: boolean } = {}) {
  const faux = fauxProvider({ tokensPerSecond: 40 });
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  const step: FauxResponseStep = (context) => {
    const last = [...context.messages]
      .reverse()
      .find((message) => message.role !== "system");
    const text = textOf(last?.content);
    if (last?.role === "toolResult")
      return fauxAssistantMessage([fauxText(`merged: ${text}`)]);
    prompts.push(text);
    const first = text.split("\n")[0] ?? "";
    if (first.startsWith("delegate "))
      return fauxAssistantMessage(
        [fauxToolCall("delegate_graph", JSON.parse(first.slice(9)))],
        { stopReason: "toolUse" },
      );
    if (first.includes("fail"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `cannot ${first}`,
      });
    if (first.includes("slow") && options.slow !== false)
      return fauxAssistantMessage(`${first} `.repeat(400));
    return fauxAssistantMessage(`done: ${first}`);
  };
  faux.setResponses(Array.from({ length: 300 }, () => step));
  return { models, prompts };
}

async function open(
  options: {
    storage?: Storage;
    models?: ReturnType<typeof scripted>["models"];
    limits?: Partial<DelegationLimits>;
  } = {},
): Promise<AgentService> {
  const service = await AgentService.open({
    storage: options.storage ?? new MemoryStorage(),
    models: options.models ?? scripted().models,
    cwd: process.cwd(),
    extensions: [
      createToolsExtension(),
      createPromptExtension({ trusted: () => false, skills: async () => [] }),
    ],
    resolveHelper: inheritHelper,
    ...(options.limits ? { delegationLimits: options.limits } : {}),
  });
  services.push(service);
  return service;
}

async function reopen(
  service: AgentService,
  options: Parameters<typeof open>[0],
): Promise<AgentService> {
  await service.close();
  services = services.filter((each) => each !== service);
  return open(options);
}

type Helper = {
  name?: string;
  task: string;
  after?: string[];
  tools?: string[];
};

function delegate(agents: Helper[], extra: Record<string, unknown> = {}) {
  return `delegate ${JSON.stringify({ agents, ...extra })}`;
}

const fanOut: Helper[] = [
  { name: "api", task: "map api" },
  { name: "tests", task: "map tests" },
  { name: "merge", task: "merge", after: ["api", "tests"] },
];

function lead(task: string, extra: Record<string, unknown> = {}) {
  return {
    name: "lead",
    task,
    delegate: true,
    cwd: ".",
    model: MODEL,
    ...extra,
  };
}

describe("delegation", () => {
  test("an agent starts helpers and merges their results", async () => {
    const service = await open();
    const info = await service.spawn(lead(delegate(fanOut)));
    expect(info.delegates).toBe(true);
    expect(info.tools).not.toContain("delegate_graph");
    const outcome = await service.wait(["lead"]);
    const text = outcome.agents[0]?.result?.text ?? "";
    expect(text).toStartWith(
      "merged: Graph lead.helpers: lead.merge answered:\n\ndone: merge",
    );
    const [graph] = service.graphs({ includeClosed: true });
    expect(graph?.owner).toBe(info.id);
    expect(graph?.name).toBe("lead.helpers");
    expect(graph?.nodes.map((node) => node.name)).toEqual([
      "lead.api",
      "lead.tests",
      "lead.merge",
    ]);
    // The call ended, so the helpers left the panel.
    expect(graph?.closed).toBe(true);
    expect(service.graphs()).toEqual([]);
    expect(service.list()).toEqual([]);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(await service.liveTasks()).toEqual([]);
  });

  test("helper names are qualified with their agent's", async () => {
    const service = await open();
    const long = "a-rather-long-agent-name-for-testing-limits";
    await service.spawn(
      lead(
        delegate([{ name: "essay_writers_group", task: "x" }], {
          name: "essay_writers_group",
        }),
        { name: long },
      ),
    );
    await service.wait([long]);
    const [graph] = service.graphs({ includeClosed: true });
    // The agent's part shortens; names stay unique across graphs and agents.
    expect(graph?.name).toBe("a-rather-long-agent-name.essay_writers_group");
    expect(graph?.nodes[0]?.name).toBe(
      "a-rather-long-agent-name.essay_writers_group-2",
    );
  });

  test("helpers and other agents can't start helpers", async () => {
    const { models } = scripted();
    const service = await open({ models });
    // A helper asked to delegate has no such tool.
    await service.spawn(
      lead(
        delegate([
          { name: "deep", task: delegate([{ task: "too deep" }]) },
          { name: "plain", task: "plain" },
        ]),
      ),
    );
    await service.wait(["lead"]);
    expect(service.get("lead.deep")?.delegates).toBeUndefined();
    expect(service.graphs({ includeClosed: true })).toHaveLength(1);
    // Neither has an agent without delegate.
    await service.spawn({
      name: "solo",
      task: delegate([{ task: "x" }]),
      cwd: ".",
      model: MODEL,
    });
    const solo = await service.wait(["solo"]);
    expect(solo.agents[0]?.result?.text).toStartWith("merged: ");
    expect(service.graphs({ includeClosed: true })).toHaveLength(1);
  });

  test("a waiting agent shows its helpers' progress", async () => {
    const service = await open();
    await service.spawn(
      lead(
        delegate([
          { name: "a", task: "a" },
          { name: "b", task: "slow b" },
        ]),
      ),
    );
    await until(() => service.get("lead")?.activity.delegation?.done === 1);
    expect(service.get("lead")?.activity).toMatchObject({
      delegation: { graph: "lead.helpers", done: 1, total: 2 },
    });
    expect(service.get("lead")?.activity.tool).toBeUndefined();
    expect(service.graphs().map((graph) => graph.name)).toEqual([
      "lead.helpers",
    ]);
    await service.stop("lead");
  });

  test("interrupting the agent stops its helpers", async () => {
    const service = await open();
    await service.spawn(
      lead(
        delegate([
          { name: "a", task: "slow a" },
          { name: "b", task: "slow b" },
        ]),
      ),
    );
    await until(() => service.get("lead.b")?.state === "working");
    await service.interrupt("lead");
    await until(() => service.graphs().length === 0);
    expect(await service.liveTasks()).toEqual([]);
    expect(service.get("lead")?.state).toBe("interrupted");
    expect(service.get("lead.a")?.state).toBe("interrupted");
    const [graph] = service.graphs({ includeClosed: true });
    expect(graph?.state).toBe("interrupted");
  });

  test("stopping a graph reaches the helpers of its agents", async () => {
    const service = await open();
    await service.spawnGraph({
      name: "top",
      agents: [
        lead(delegate([{ name: "a", task: "slow a" }])),
        { name: "other", task: "slow other", cwd: ".", model: MODEL },
      ],
    });
    await until(() => service.get("lead.a")?.state === "working");
    await service.stop("top");
    expect(await service.liveTasks()).toEqual([]);
    expect(service.get("lead.a")?.state).toBe("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.pendingDeliveries()).toEqual([]);
  });

  test("stopping the helpers lets the agent go on", async () => {
    const service = await open();
    await service.spawn(
      lead(
        delegate([
          { name: "a", task: "slow a" },
          { name: "b", task: "b" },
        ]),
      ),
    );
    await until(
      () =>
        service.get("lead.a")?.state === "working" &&
        service.get("lead.b")?.result?.text === "done: b",
    );
    const stopped = await service.stop("lead.helpers");
    expect(stopped.kind).toBe("graph");
    const outcome = await service.wait(["lead"]);
    const text = outcome.agents[0]?.result?.text ?? "";
    expect(text).toStartWith(
      "merged: The helpers were stopped before they finished.",
    );
    expect(text).toContain("## lead.b (answered)");
  });

  test("helpers get only the tools of their agent", async () => {
    const service = await open({ limits: { perCall: 2, active: 2 } });
    await service.spawn(
      lead(delegate([{ name: "a", task: "a", tools: ["bash"] }]), {
        tools: ["read"],
      }),
    );
    const tools = await service.wait(["lead"]);
    expect(tools.agents[0]?.result?.text).toBe(
      "merged: Helper a asks for tools you don't have: bash. Your tools: read",
    );
    await service.spawn(
      lead(
        delegate([
          { name: "a", task: "a" },
          { name: "b", task: "b" },
          { name: "c", task: "c" },
        ]),
        { name: "big" },
      ),
    );
    const big = await service.wait(["big"]);
    expect(big.agents[0]?.result?.text).toBe(
      "merged: One call starts at most 2 helpers, not 3",
    );
    expect(service.graphs({ includeClosed: true })).toEqual([]);
  });

  test("a session caps helpers that work at once", async () => {
    const service = await open({ limits: { active: 1 } });
    await service.spawn(lead(delegate([{ name: "a", task: "slow a" }])));
    await until(() => service.get("lead.a")?.state === "working");
    await service.spawn(
      lead(delegate([{ name: "b", task: "b" }]), { name: "second" }),
    );
    const second = await service.wait(["second"]);
    expect(second.agents[0]?.result?.text).toStartWith(
      "merged: At most 1 helpers can work at once",
    );
    await service.stop("lead");
  });
});

describe("delegation durability", () => {
  test("a restart mid-delegation starts no second set of helpers", async () => {
    const directory = tempDir();
    const first = scripted();
    const before = await open({
      storage: await jsonlStorage(directory),
      models: first.models,
    });
    await before.spawn(
      lead(
        delegate([
          { name: "a", task: "a" },
          { name: "b", task: "slow b" },
        ]),
      ),
    );
    await until(
      () =>
        before.get("lead.a")?.result?.text === "done: a" &&
        before.get("lead.b")?.state === "working",
    );

    const second = scripted({ slow: false });
    const after = await reopen(before, {
      storage: await jsonlStorage(directory),
      models: second.models,
    });
    await until(() => after.pendingDeliveries().length === 1);
    const [delivery] = after.pendingDeliveries();
    if (delivery?.kind !== "agent" || delivery.outcome.kind !== "answered")
      throw new Error("expected the lead's answer");
    expect(delivery.outcome.result.text).toContain("## lead.b (answered)");
    expect(after.graphs({ includeClosed: true })).toHaveLength(1);
    // Only b's interrupted answer ran again; a and the lead's task didn't.
    expect(second.prompts).toEqual(["slow b"]);
    expect(first.prompts.filter((prompt) => prompt === "a")).toHaveLength(1);
  });
});
