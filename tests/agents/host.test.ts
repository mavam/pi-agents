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
import {
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  agentSelection,
  installAgentExtensions,
} from "../../src/agents/extensions.js";
import { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  createFaux,
  hostOf,
  lastUserText,
  MODEL,
  openService,
  TEST_REFRESH_MS,
  TestParent,
  testExtensions,
} from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function agent(name: string, job: string) {
  return { name, job, cwd: ".", model: MODEL };
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
      refreshDelayMs: TEST_REFRESH_MS,
    });
    cleanups.push(() => service.close());
    harness.resume();

    const graph = await service.spawnGraph({
      name: "g",
      agents: [
        { name: "a", job: "a", cwd: ".", model: MODEL },
        { name: "b", job: "b", cwd: ".", model: MODEL, after: ["a"] },
      ],
    });
    const task = await harness.getTask(Number(graph.id) as TaskId, CONTEXT);
    expect(task?.conversationId).toBe(anchor.id);
    expect(task?.background).toBe(true);
    await service.spawnGraph({
      agents: [{ name: "solo", job: "solo", cwd: ".", model: MODEL }],
    });
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
    // default, with a `read` tool of its own.
    const foreign = defineExtension({
      name: "host-coding",
      tools: [
        defineTool({
          name: "read",
          description: "The host's read",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [{ type: "text", text: "read" }] }),
        }),
      ],
    });
    // The lead spawns one agent, then answers with its result.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const step: FauxResponseStep = (context) => {
      if (context.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage([fauxText("checking")]);
      if (lastUserText(context).startsWith("[results] "))
        return fauxAssistantMessage([fauxText("merged")]);
      if (lastUserText(context).startsWith("spawn"))
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "h", job: "help" }],
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
      refreshDelayMs: TEST_REFRESH_MS,
    });
    cleanups.push(() => service.close());
    harness.resume();

    await service.spawnGraph({ agents: [agent("solo", "solo")] });
    await service.spawnGraph({
      name: "g",
      agents: [agent("x", "one"), { ...agent("y", "two"), after: ["x"] }],
    });
    await service.spawnGraph({
      agents: [{ ...agent("lead", "spawn"), spawn: true }],
    });
    await service.wait(["solo", "g", "lead"]);
    expect(service.get("lead")?.result?.text).toBe("merged");

    const ours = [extensions.tools.name, extensions.prompt.name];
    // Every agent messages; only agents that may spawn select spawning.
    const messaging = [...ours, extensions.messaging.name];
    for (const [name, selected] of [
      ["solo", messaging],
      ["x", messaging],
      ["lead", [...ours, extensions.spawning.name, extensions.messaging.name]],
      ["lead.h", messaging],
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
  });

  test("Pi's host anchors graphs on the root conversation", async () => {
    const service = await openService();
    cleanups.push(() => closeService(service));
    const { harness, anchor } = hostOf(service).harness;
    expect(anchor.id).toBe(ROOT_CONVERSATION_ID);
    const graph = await service.spawnGraph({
      name: "g",
      agents: [
        { job: "a", cwd: ".", model: MODEL },
        { job: "b", cwd: ".", model: MODEL },
      ],
    });
    const task = await harness.getTask(Number(graph.id) as TaskId, CONTEXT);
    expect(task?.conversationId).toBe(ROOT_CONVERSATION_ID);
  });
});
