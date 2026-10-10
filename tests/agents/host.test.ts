import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from "@earendil-works/pi-durable";
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
});
