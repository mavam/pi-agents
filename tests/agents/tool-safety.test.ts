import { afterEach, expect, test } from "bun:test";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  type HostOptions,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;
let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (
    (content as Array<{ type: string; text?: string }> | undefined)
      ?.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
      .join("") ?? ""
  );
}

function modelsOf(step: FauxResponseStep) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return models;
}

async function open(options: HostOptions): Promise<AgentService> {
  const service = await openService(options);
  services.push(service);
  return service;
}

const spec = (name: string, job: string) => ({
  name,
  job,
  cwd: ".",
  model: MODEL,
});
const send = (name: string) =>
  `send ${JSON.stringify({ name, message: "hello" })}`;

const messagingStep: FauxResponseStep = (context) => {
  const last = context.messages
    .filter((message) => message.role !== "system")
    .at(-1);
  const text = textOf(last?.content);
  if (last?.role === "toolResult") return fauxAssistantMessage(`tool: ${text}`);
  for (const [prefix, tool] of [
    ["send ", "agent_send"],
    ["spawn ", "agent_spawn"],
  ]) {
    if (prefix && tool && text.startsWith(prefix))
      return fauxAssistantMessage(
        [fauxToolCall(tool, JSON.parse(text.slice(prefix.length)))],
        { stopReason: "toolUse" },
      );
  }
  return fauxAssistantMessage(`done: ${text}`);
};

test("interrupting agent_stop does not wait for the stop's refresh", async () => {
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  let releaseChild!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let stopping = false;
  const models = modelsOf(async (context, request) => {
    const last = context.messages
      .filter((message) => message.role !== "system")
      .at(-1);
    const text = textOf(last?.content);
    if (last?.role === "toolResult" && last.toolName === "agent_spawn") {
      await started;
      return fauxAssistantMessage(
        [fauxToolCall("agent_stop", { name: "child" })],
        { stopReason: "toolUse" },
      );
    }
    if (text === "lead")
      return fauxAssistantMessage(
        [
          fauxToolCall("agent_spawn", {
            agents: [{ name: "child", job: "child" }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (text === "child") {
      childStarted();
      await heldUntilAborted(request?.signal);
      stopping = true;
      await released;
    }
    return fauxAssistantMessage("done");
  });
  const service = await open({ models });
  try {
    await service.spawnGraph({
      agents: [{ ...spec("lead", "lead"), spawn: true }],
    });
    await until(() => stopping);
    // Interrupt must finish even while the child's stop is still draining.
    await awaitWithContext(
      service.interrupt("lead"),
      withAbortSignal(AbortSignal.timeout(2_000), CONTEXT),
    );
    expect(service.get("lead")?.state).toBe("interrupted");
    releaseChild();
    await until(() => service.get("lead.child")?.closed === true);
    await until(async () =>
      (await service.liveTasks()).every((task) => task.kind !== "pi.tool"),
    );
    expect(service.get("lead")?.state).toBe("interrupted");
    expect(service.pendingDeliveries()).toEqual([]);
  } finally {
    releaseChild();
  }
}, 10_000);

test("agent_send prefers IDs to numeric names and replays a logged send only once", async () => {
  const directory = tempDir();
  let logged = false;
  const before = await open({
    models: modelsOf(messagingStep),
    storage: await jsonlStorage(directory),
    messaging: {
      afterLog: async (context) => {
        logged = true;
        await awaitWithContext(new Promise(() => {}), context);
      },
    },
  });
  const graph = await before.spawnGraph({
    agents: [spec("recipient", "idle")],
  });
  const recipientId = graph.nodes[0]?.agentId ?? "";
  await until(() => before.get("recipient")?.state === "idle");
  // This agent's name collides with the first agent's ID, not its name.
  const shadow = await before.spawnGraph({
    agents: [spec(recipientId, "numeric name")],
  });
  const shadowId = shadow.nodes[0]?.agentId ?? "";
  await until(() => before.agentById(shadowId)?.state === "idle");
  await before.spawnGraph({ agents: [spec("sender", send(recipientId))] });
  await until(() => logged);
  await closeService(before);
  services = services.filter((service) => service !== before);
  const after = await open({
    models: modelsOf(messagingStep),
    storage: await jsonlStorage(directory),
  });
  await until(
    () => after.get("sender")?.result?.text === "tool: Sent to recipient.",
  );
  await until(
    () => after.get("recipient")?.result?.text === "done: [from sender] hello",
  );
  expect(after.messages()).toHaveLength(1);
  expect(after.messages()[0]?.to.id).toBe(recipientId);
  expect(after.agentById(shadowId)?.result?.text).toBe("done: numeric name");
  const conversation = await hostOf(after).harness.harness.conversation(
    Number(recipientId) as ConversationId,
    CONTEXT,
  );
  const entries = await conversation?.entries({}, 200, undefined, CONTEXT);
  expect(
    entries?.items.filter((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "user" &&
          textOf(message.content) === "[from sender] hello",
      ),
    ),
  ).toHaveLength(1);
}, 10_000);

test("agent IDs do not bypass messaging reachability", async () => {
  const service = await open({ models: modelsOf(messagingStep) });
  const outside = await service.spawnGraph({
    agents: [spec("outside", "idle")],
  });
  await until(() => service.get("outside")?.state === "idle");
  await service.spawnGraph({
    agents: [
      {
        ...spec(
          "lead",
          `spawn ${JSON.stringify({ agents: [{ name: "child", job: send(outside.nodes[0]?.agentId ?? "") }] })}`,
        ),
        spawn: true,
      },
    ],
  });
  await until(() => service.get("lead.child")?.result !== undefined);
  expect(service.get("lead.child")?.result?.text).toContain(
    "within your reach",
  );
  expect(service.messages()).toEqual([]);
});
