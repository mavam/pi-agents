import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  section,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  agentSelection,
  installAgentExtensions,
} from "../../src/agents/extensions.js";
import { AgentsDoc } from "../../src/agents/records.js";
import { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  createFaux,
  hostOf,
  jsonlStorage,
  lastUserText,
  MODEL,
  openService,
  TestParent,
  tempDir,
  testExtensions,
  until,
} from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function agent(name: string, task: string) {
  return { name, task, cwd: ".", model: MODEL };
}

describe("hosts", () => {
  test("the core runs on the harness and anchor its host chose", async () => {
    // A host of its own: its registry holds an extension of its own next to
    // pi-agents', and its anchor is an ordinary conversation, not the root.
    const extensions = testExtensions();
    const registry = createRegistry();
    registry.install(defineExtension({ name: "host-own" }));
    installAgentExtensions(registry, extensions);
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: createFaux().models,
        registry,
        settings: { extensions: agentSelection(extensions) },
      },
      CONTEXT,
    );
    cleanups.push(() => harness.close(CONTEXT));
    const anchor = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      CONTEXT,
    );
    const service = await AgentService.start({
      harness,
      anchor,
      extensions,
      parent: new TestParent(),
    });
    cleanups.push(() => service.close());

    const graph = await service.spawnGraph({
      name: "g",
      agents: [
        { name: "a", task: "a", cwd: ".", model: MODEL },
        { name: "b", task: "b", cwd: ".", model: MODEL, after: ["a"] },
      ],
    });
    const task = await harness.getTask(Number(graph.id) as TaskId, CONTEXT);
    expect(task?.conversationId).toBe(anchor.id);
    expect(task?.background).toBe(true);
    await service.spawn({ name: "solo", task: "solo", cwd: ".", model: MODEL });
    const outcome = await service.wait(["g", "solo"]);
    expect(outcome.timedOut).toEqual([]);
    expect(service.get("solo")?.result?.text).toBe("done: solo");
    // The core never created or used the root conversation.
    expect(
      await harness.conversation(ROOT_CONVERSATION_ID, CONTEXT),
    ).toBeUndefined();
  });

  test("agents select pi-agents' extensions, not the host's defaults", async () => {
    // Like Pi's session worker, the host selects its own extension by
    // default: a `read` tool, another tool, and a prompt section.
    const tool = (name: string) =>
      defineTool({
        name,
        description: `The host's ${name}`,
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ content: [{ type: "text", text: name }] }),
      });
    const foreign = defineExtension({
      name: "host-coding",
      tools: [tool("read"), tool("host_tool")],
      sections: [section("host_rules", () => "Follow the host.")],
    });
    // The model delegates when asked and records what each request offers.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const offered: string[][] = [];
    const step: FauxResponseStep = (context) => {
      // System messages declare the request's sections and tools.
      const systems = context.messages.filter(
        (message) => (message.role as string) === "system",
      ) as Array<{ sections?: object; toolsAdded?: Array<{ name: string }> }>;
      offered.push(
        systems.flatMap((system) => [
          ...(system.toolsAdded ?? []).map((each) => `tool:${each.name}`),
          ...Object.keys(system.sections ?? {}).map((key) => `section:${key}`),
        ]),
      );
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage([fauxText("merged")]);
      if (lastUserText(context).startsWith("delegate"))
        return fauxAssistantMessage(
          [
            fauxToolCall("delegate_graph", {
              agents: [{ name: "h", task: "help" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("done");
    };
    faux.setResponses(Array.from({ length: 20 }, () => step));

    const extensions = testExtensions();
    const registry = createRegistry();
    registry.install(foreign);
    installAgentExtensions(registry, extensions);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, settings: { extensions: [foreign] } },
      CONTEXT,
    );
    cleanups.push(() => harness.close(CONTEXT));
    const service = await AgentService.start({
      harness,
      anchor: await harness.root(CONTEXT),
      extensions,
      parent: new TestParent(),
    });
    cleanups.push(() => service.close());

    await service.spawn(agent("solo", "solo"));
    await service.spawnGraph({
      name: "g",
      agents: [agent("x", "one"), { ...agent("y", "two"), after: ["x"] }],
    });
    await service.spawn({ ...agent("lead", "delegate"), delegate: true });
    await service.wait(["solo", "g", "lead"]);
    expect(service.get("lead")?.result?.text).toBe("merged");

    const ours = [extensions.tools.name, extensions.prompt.name];
    for (const [name, selected] of [
      ["solo", ours],
      ["x", ours],
      ["y", ours],
      ["lead", [...ours, extensions.delegation.name]],
      ["lead.h", ours],
    ] as const) {
      const id = Number(service.get(name)?.id) as ConversationId;
      const conversation = await harness.conversation(id, CONTEXT);
      const resolved = await conversation?.agent(CONTEXT);
      expect(
        resolved?.extensions.map((each) => each.name),
        name,
      ).toEqual([...selected]);
      for (const each of resolved?.tools ?? [])
        expect(foreign.tools, `${name}: ${each.name}`).not.toContain(each);
    }
    expect(offered).toHaveLength(6);
    for (const request of offered) {
      expect(request).not.toContain("tool:host_tool");
      expect(request).not.toContain("section:host_rules");
      expect(request).toContain("tool:read");
    }
  });

  test("Pi's host anchors graphs on the root conversation", async () => {
    const service = await openService();
    cleanups.push(() => closeService(service));
    const { harness, anchor } = hostOf(service).harness;
    expect(anchor.id).toBe(ROOT_CONVERSATION_ID);
    const graph = await service.spawnGraph({
      name: "g",
      agents: [
        { task: "a", cwd: ".", model: MODEL },
        { task: "b", cwd: ".", model: MODEL },
      ],
    });
    const task = await harness.getTask(Number(graph.id) as TaskId, CONTEXT);
    expect(task?.conversationId).toBe(ROOT_CONVERSATION_ID);
  });
});

/**
 * `tests/fixtures/v0.27.0` is the JSONL storage of pi-agents v0.27.0 after:
 * spawning `a` (answered, undelivered); spawning `b`, waiting for it, and
 * sending it `again` (request `parent:2`, undelivered); graph `g` of `x →
 * y` (finished, undelivered); spawning and stopping `s`; and, still working
 * at shutdown, graph `h` of `p → q` and agent `w`.
 */
async function openFixture(): Promise<AgentService> {
  const directory = tempDir("pi-agents-fixture-");
  const fixture = path.join(import.meta.dir, "..", "fixtures", "v0.27.0");
  for (const file of fs.readdirSync(fixture))
    fs.copyFileSync(path.join(fixture, file), path.join(directory, file));
  const service = await openService({
    storage: await jsonlStorage(directory),
    models: createFaux().models,
  });
  cleanups.push(() => closeService(service));
  return service;
}

describe("sessions stored by earlier versions", () => {
  test("open with their agents, graphs, and undelivered results", async () => {
    const service = await openFixture();
    expect(
      service
        .list({ includeClosed: true })
        .map((info) => `${info.name}${info.closed ? " (closed)" : ""}`),
    ).toEqual(["a", "b", "x", "y", "s (closed)", "p", "q", "w"]);
    expect(service.get("s")?.result?.text).toBe("done: gamma");
    expect(service.get("b")?.result?.text).toBe("done: again");
    // Its agents name no extensions and follow the default of Pi's host.
    const { harness: opened } = hostOf(service).harness;
    const a = Number(service.get("a")?.id) as ConversationId;
    expect(
      (await opened.snapshot(AgentDoc, a, CONTEXT))?.extensions,
    ).toBeUndefined();
    const resolved = await (await opened.conversation(a, CONTEXT))?.agent(
      CONTEXT,
    );
    expect(resolved?.extensions.map((each) => each.name)).toEqual([
      "pi-agents-tools",
      "pi-agents-prompt",
    ]);

    // Work that stopped at shutdown resumes; the graph on the old anchor
    // finishes and delivers.
    await until(() => service.pendingDeliveries().length === 5);
    expect(
      service
        .pendingDeliveries()
        .map((each) => each.name)
        .sort(),
    ).toEqual(["a", "b", "g", "h", "w"]);
    expect(
      service.getGraph("h")?.nodes.map((node) => node.outcome?.kind),
    ).toEqual(["answered", "answered"]);
    const { harness, anchor } = hostOf(service).harness;
    const h = service.getGraph("h");
    const task = await harness.getTask(Number(h?.id) as TaskId, CONTEXT);
    expect(task?.conversationId).toBe(anchor.id);

    for (const delivery of service.pendingDeliveries())
      await service.acknowledge(delivery);
    expect(service.pendingDeliveries()).toEqual([]);
    expect(service.list().map((info) => info.name)).toEqual([]);

    // Messages continue the stored request numbering.
    await service.send("b", "once more", "auto");
    const b = service.get("b")?.id as string;
    const records = await harness.snapshot(AgentsDoc, CONTEXT);
    expect(Object.keys(records?.agents[b]?.requests ?? {})).toEqual([
      "parent:3",
    ]);
    await until(() => service.pendingDeliveries().length === 1);
    expect(service.get("b")?.result?.text).toBe("done: once more");
  });

  test("take keyed calls next to what they stored", async () => {
    const service = await openFixture();
    await until(() => service.pendingDeliveries().length === 5);
    const { harness } = hostOf(service).harness;
    const requests = async (name: string) => {
      const id = service.get(name)?.id as string;
      const records = await harness.snapshot(AgentsDoc, CONTEXT);
      return Object.keys(records?.agents[id]?.requests ?? {});
    };

    // `b` still owes the answer to `parent:2`.
    await service.send("b", "keyed", "auto", { call: "k1" });
    await service.send("b", "keyed", "auto", { call: "k1" });
    expect(await requests("b")).toEqual(["parent:2", "call:k1"]);

    // A record without `stops` takes a keyed stop, which acts once.
    await service.stop("a", { call: "k2" });
    await service.send("a", "again", "auto");
    await service.stop("a", { call: "k2" });
    expect(service.get("a")?.closed).toBe(false);
    expect(await requests("a")).toEqual(["parent:2"]);

    const spawned = await service.spawn(
      { name: "n", task: "new", cwd: ".", model: MODEL },
      { call: "k3" },
    );
    const again = await service.spawn(
      { name: "n", task: "new", cwd: ".", model: MODEL },
      { call: "k3" },
    );
    expect(again.id).toBe(spawned.id);
  });
});
