import { afterEach, describe, expect, test } from "bun:test";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import type { MessagingOptions } from "../../src/agents/messaging.js";
import { AgentsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import { parseMessageInput } from "../../src/agents/types.js";
import { agentToolViews } from "../../src/ui/tool-views.js";
import {
  briefly,
  closeService,
  gate,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "./helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

/**
 * `send <json>` calls agent_send, `spawn <json>` agent_spawn, a
 * message answers `got: <text>`, a tool
 * result `tool: <text>`, prompts and messages with `hold` wait until
 * aborted, prompts with `briefly` work briefly, and prompts with `linger`
 * wait until aborted, then until `lingering` is released.
 */
function scripted(lingering?: { aborted: () => void; promise: Promise<void> }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const step: FauxResponseStep = async (context, options) => {
    const last = [...context.messages]
      .reverse()
      .find((message) => message.role !== "system");
    const text = textOf(last?.content);
    if (last?.role === "toolResult")
      return fauxAssistantMessage(`tool: ${text}`);
    if (text === "sleep")
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: "sleep 0.3" })],
        { stopReason: "toolUse" },
      );
    if (text === "status")
      return fauxAssistantMessage([fauxToolCall("agent_status", {})], {
        stopReason: "toolUse",
      });
    if (text.startsWith("spawn "))
      return fauxAssistantMessage(
        [fauxToolCall("agent_spawn", JSON.parse(text.slice(6)))],
        { stopReason: "toolUse" },
      );
    if (text.startsWith("send "))
      return fauxAssistantMessage(
        [fauxToolCall("agent_send", JSON.parse(text.slice(5)))],
        { stopReason: "toolUse" },
      );
    if (text.includes("hold")) await heldUntilAborted(options?.signal);
    if (text.includes("linger")) {
      await heldUntilAborted(options?.signal);
      lingering?.aborted();
      await lingering?.promise;
    }
    if (text.includes("briefly")) await briefly(options?.signal, 300);
    const message = parseMessageInput(text);
    if (message) return fauxAssistantMessage(`got: ${message.text}`);
    return fauxAssistantMessage(`done: ${text}`);
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return models;
}

async function open(
  options: {
    storage?: Storage;
    messaging?: MessagingOptions;
    models?: ReturnType<typeof scripted>;
  } = {},
): Promise<AgentService> {
  const service = await openService({
    models: options.models ?? scripted(),
    messaging: options.messaging ?? {},
    ...(options.storage ? { storage: options.storage } : {}),
  });
  services.push(service);
  return service;
}

/** Close the service, then open its directory again, never both at once. */
async function reopen(
  service: AgentService,
  directory: string,
  messaging: MessagingOptions,
): Promise<AgentService> {
  await closeService(service);
  services = services.filter((each) => each !== service);
  return open({ storage: await jsonlStorage(directory), messaging });
}

/** An agent's transcript entries. */
async function entries(service: AgentService, name: string) {
  const id = Number(service.get(name)?.id) as ConversationId;
  const conversation = await hostOf(service).harness.harness.conversation(
    id,
    BACKGROUND_CONTEXT,
  );
  const page = await conversation?.entries(
    {},
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page?.items ?? [];
}

/** An agent's transcript as JSON text. */
async function transcript(service: AgentService, name: string) {
  return JSON.stringify(await entries(service, name));
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

const spec = (name: string, job: string) => ({
  name,
  job,
  cwd: ".",
  model: MODEL,
});

const SEND = `send ${JSON.stringify({ name: "b", message: "hello" })}`;

describe("messaging", () => {
  test("a message reaches its recipient, and the answer stays there", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => service.get("b")?.state === "idle");
    await service.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => service.get("b")?.state === "idle");
    await until(() => service.messages()[0]?.status === "delivered");
    expect(service.get("a")?.result?.text).toBe("tool: Sent to b.");
    expect(service.messages()).toMatchObject([
      { from: { name: "a" }, to: { name: "b" }, text: "hello" },
    ]);
    // Only the agents' job answers wait for the parent.
    expect(
      service
        .pendingDeliveries()
        .map((delivery) =>
          delivery.kind === "graph" &&
          delivery.nodes[0]?.outcome.kind === "answered"
            ? delivery.nodes[0].outcome.result.text
            : delivery.kind,
        )
        .sort(),
    ).toEqual(["done: idle", "tool: Sent to b."]);
  });

  test("a crash after logging delivers once", async () => {
    const directory = tempDir();
    let held = false;
    const before = await open({
      storage: await jsonlStorage(directory),
      messaging: {
        afterLog: async (context) => {
          held = true;
          await awaitWithContext(new Promise(() => {}), context);
        },
      },
    });
    await before.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => before.get("b")?.state === "idle");
    await before.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => held);

    const after = await reopen(before, directory, {});
    await until(() => after.get("a")?.result?.text === "tool: Sent to b.");
    await until(() => after.get("b")?.result?.text === "got: hello");
    expect(count(await transcript(after, "b"), "[from a] hello")).toBe(1);
    expect(after.messages()).toMatchObject([{ text: "hello" }]);
  });

  test("a crash-left message to a stopped recipient is dropped, not delivered", async () => {
    const directory = tempDir();
    let held = false;
    const before = await open({
      storage: await jsonlStorage(directory),
      messaging: {
        afterLog: async (context) => {
          held = true;
          await awaitWithContext(new Promise(() => {}), context);
        },
      },
    });
    await before.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => before.get("b")?.state === "idle");
    await before.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => held);
    // b's stop is recorded, as when a stop ran while the send waited.
    const b = before.get("b")?.id as string;
    await hostOf(before).harness.harness.commit(async (tx) => {
      const record = (await tx.doc(AgentsDoc)).agents[b];
      if (record) record.stopped = true;
    }, BACKGROUND_CONTEXT);

    const after = await reopen(before, directory, {});
    expect(after.messages()).toMatchObject([{ status: "dropped" }]);
    expect(await transcript(after, "b")).not.toContain("[from a]");
  });

  test("a rerun sends to the agent the first run bound, not to its name", async () => {
    const directory = tempDir();
    let held = false;
    const before = await open({
      storage: await jsonlStorage(directory),
      messaging: {
        afterBind: async (context) => {
          held = true;
          await awaitWithContext(new Promise(() => {}), context);
        },
      },
    });
    await before.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => before.get("b")?.state === "idle");
    await before.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => held);
    // The bound agent stops, and another one takes its name.
    await before.stop("b");
    await before.spawnGraph({ agents: [spec("b", "idle again")] });

    const after = await reopen(before, directory, {});
    await until(() => after.get("a")?.state === "idle");
    expect(after.get("a")?.result?.text).toBe(
      "tool: b was stopped and doesn't take messages from agents.",
    );
    expect(await transcript(after, "b")).not.toContain("[from a]");
    expect(after.messages()).toEqual([]);
  });

  test("a stop waits for a send to the same agent, then interrupts it", async () => {
    let logged!: () => void;
    let release!: () => void;
    const isLogged = new Promise<void>((resolve) => {
      logged = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = await open({
      messaging: {
        afterLog: async () => {
          logged();
          await released;
        },
      },
    });
    await service.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => service.get("b")?.state === "idle");
    const hold = JSON.stringify({ name: "b", message: "hold on" });
    await service.spawnGraph({ agents: [spec("a", `send ${hold}`)] });
    await isLogged;
    const stopping = service.stop("b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await stopping;
    await until(() => service.get("b")?.state === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.get("b")?.state).toBe("interrupted");
  });

  test("a follow-up waits until the recipient's work ends", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "sleep")] });
    await until(() => service.get("b")?.state === "working");
    // As calls from before `mode` existed asked for it.
    const later = JSON.stringify({
      name: "b",
      message: "hello",
      followUp: true,
    });
    await service.spawnGraph({ agents: [spec("a", `send ${later}`)] });
    await until(() => service.get("b")?.result?.text === "got: hello");
    // b answered its job before the message, unlike with a steer.
    const answers = service
      .pendingDeliveries()
      .flatMap((delivery) =>
        delivery.kind === "graph" &&
        delivery.nodes[0]?.outcome.kind === "answered"
          ? [`${delivery.name}: ${delivery.nodes[0].outcome.result.text}`]
          : [],
      );
    expect(answers.some((answer) => answer.startsWith("b: tool:"))).toBe(true);
  });

  test("spawned agents reach their spawner, not unrelated agents", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => service.get("b")?.state === "idle");
    const send = (name: string) =>
      `send ${JSON.stringify({ name, message: "hi" })}`;
    const agents = [
      { name: "h", job: send("lead") },
      { name: "k", job: send("b") },
    ];
    await service.spawnGraph({
      agents: [
        {
          ...spec("lead", `spawn ${JSON.stringify({ agents })}`),
          spawn: true,
        },
      ],
    });
    await until(() => service.get("lead.k")?.result !== undefined);
    await until(() => service.get("lead.h")?.result !== undefined);
    expect(service.get("lead.h")?.result?.text).toBe("tool: Sent to lead.");
    expect(service.get("lead.k")?.result?.text).toBe(
      "tool: No agent named b within your reach.",
    );
    await service.spawnGraph({ agents: [spec("a", send("lead.h"))] });
    await until(() => service.get("a")?.state === "idle");
    expect(service.get("a")?.result?.text).toBe(
      "tool: No agent named lead.h within your reach.",
    );
    await until(() => service.messages()[0]?.status === "delivered");
    expect(service.messages()).toMatchObject([
      { from: { name: "lead.h" }, to: { name: "lead" }, text: "hi" },
    ]);
    expect(await transcript(service, "b")).not.toContain("[from lead");
  });

  test("a steer joins the recipient's work, also the answer its parent gets", async () => {
    const service = await open();
    // b works in steps: a tool call, then its answer.
    await service.spawnGraph({ agents: [spec("b", "sleep")] });
    await until(() => service.get("b")?.state === "working");
    await service.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => service.get("b")?.result?.text === "got: hello");
    const answers = service
      .pendingDeliveries()
      .flatMap((delivery) =>
        delivery.kind === "graph" &&
        delivery.nodes[0]?.outcome.kind === "answered"
          ? [`${delivery.name}: ${delivery.nodes[0].outcome.result.text}`]
          : [],
      );
    expect(answers).toContain("b: got: hello");
  });

  test("an interrupt aborts the recipient's work, whose job the message then answers", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "hold")] });
    await until(() => service.get("b")?.state === "working");
    const now = JSON.stringify({
      name: "b",
      message: "hello",
      mode: "interrupt",
    });
    await service.spawnGraph({ agents: [spec("a", `send ${now}`)] });
    await until(() => service.get("b")?.result?.text === "got: hello");
    expect(service.get("a")?.result?.text).toBe(
      "tool: Interrupted b and sent the message.",
    );
    const answers = service
      .pendingDeliveries()
      .flatMap((delivery) =>
        delivery.kind === "graph" &&
        delivery.nodes[0]?.outcome.kind === "answered"
          ? [`${delivery.name}: ${delivery.nodes[0].outcome.result.text}`]
          : [],
      );
    expect(answers).toContain("b: got: hello");
  });

  test("a crash after an interrupt's log never aborts the work its message started", async () => {
    const directory = tempDir();
    let held = false;
    const before = await open({
      storage: await jsonlStorage(directory),
      messaging: {
        afterLog: async (context) => {
          held = true;
          await awaitWithContext(new Promise(() => {}), context);
        },
      },
    });
    await before.spawnGraph({ agents: [spec("b", "hold")] });
    await until(() => before.get("b")?.state === "working");
    const now = JSON.stringify({
      name: "b",
      message: "briefly hello",
      mode: "interrupt",
    });
    await before.spawnGraph({ agents: [spec("a", `send ${now}`)] });
    await until(() => held);
    await until(() => before.get("b")?.state === "interrupted");

    // Recovery submits the logged message; the rerun only finishes the send.
    const after = await reopen(before, directory, {});
    await until(() => after.get("a")?.state === "idle");
    await until(() => after.get("b")?.result?.text === "got: briefly hello");
    expect(after.get("b")?.state).toBe("idle");
    expect(count(await transcript(after, "b"), "[from a] briefly hello")).toBe(
      1,
    );
  });

  test("agents that interrupt each other don't wait on each other", async () => {
    const service = await open();
    const interrupt = (name: string) =>
      `send ${JSON.stringify({ name, message: "hi", mode: "interrupt" })}`;
    await service.spawnGraph({
      agents: [spec("a", interrupt("b")), spec("b", interrupt("a"))],
    });
    await until(
      () =>
        service.get("a")?.state !== "working" &&
        service.get("b")?.state !== "working",
    );
  });

  test("a sender cancelled during its interrupt still holds the recipient's results", async () => {
    const aborted = gate();
    const lingering = gate();
    const service = await open({
      models: scripted({
        aborted: aborted.release,
        promise: lingering.promise,
      }),
    });
    const child = JSON.stringify({ agents: [{ name: "c", job: "hold" }] });
    await service.spawnGraph({
      agents: [{ ...spec("b", `spawn ${child}`), spawn: true }],
    });
    await until(() => service.get("b.c")?.state === "working");
    await until(() => service.get("b")?.state === "idle");
    await service.send("b", "linger", "steer");
    await until(() => service.get("b")?.state === "working");
    const now = JSON.stringify({
      name: "b",
      message: "fix",
      mode: "interrupt",
    });
    await service.spawnGraph({ agents: [spec("a", `send ${now}`)] });
    // a's interrupt is underway: b's work aborted, but its cleanup lingers.
    await aborted.promise;
    await service.interrupt("a");
    lingering.release();
    await until(() => service.get("b")?.state === "interrupted");
    // b's group finishes; its results wait for b's next answer.
    await service.interrupt("b.c");
    await service.prompt("b.c", "go on", "auto");
    await until(
      () => service.get("b.c")?.result?.text === "done: [user] go on",
    );
    await Bun.sleep(100);
    const kinds = (await entries(service, "b")).map((entry) => entry.kind);
    expect(kinds).not.toContain("pi-agents.results");
    expect(await transcript(service, "b")).not.toContain("[from a]");
    expect(service.get("b")?.state).toBe("interrupted");
  });

  test("interrupting a busy recipient drops its queued messages", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "hold")] });
    await until(() => service.get("b")?.state === "working");
    await service.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => service.messages()[0]?.status === "queued");
    await service.interrupt("b");
    await until(() => service.messages()[0]?.status === "dropped");
    expect(await transcript(service, "b")).not.toContain("[from a]");
  });

  test("agent_status lists whom a send reaches, with their jobs, as the attach view draws it", async () => {
    const service = await open();
    // An older b that answered and closed; the newer b takes its name, so
    // only the newer one is listed.
    await service.spawnGraph({ agents: [spec("b", "Old job.")] });
    await until(() => service.pendingDeliveries().length === 1);
    await service.acknowledge(service.pendingDeliveries()[0] as never);
    await until(() => service.list().length === 0);
    await service.spawnGraph({ agents: [spec("b", "Keep notes. Then rest.")] });
    await until(() => service.get("b")?.state === "idle");
    await service.spawnGraph({ agents: [spec("a", "status")] });
    await until(() => service.get("a")?.state === "idle");
    const result = (await entries(service, "a"))
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    if (result?.role !== "toolResult") throw new Error("no status result");
    expect(textOf(result.content)).toBe(
      "## b (idle)\nJob:\nKeep notes. Then rest.",
    );
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    expect(
      agentToolViews(() => "a")
        .agent_status?.renderResult?.(
          result,
          { expanded: false, isPartial: false },
          // biome-ignore lint/suspicious/noExplicitAny: a plain test theme.
          theme as any,
          // biome-ignore lint/suspicious/noExplicitAny: renderers read isError.
          { isError: false, state: {} } as any,
        )
        .render(80),
    ).toEqual(["  ● b faux-1 Keep notes. Then rest."]);
  });

  test("agent_status shows jobs whole", async () => {
    const service = await open();
    // Longer than pi-durable's default output limit of 50 KB.
    const job = `Keep notes. ${"x".repeat(60_000)}`;
    await service.spawnGraph({ agents: [spec("b", job)] });
    await until(() => service.get("b")?.state === "idle");
    await service.spawnGraph({ agents: [spec("a", "status")] });
    await until(() => service.get("a")?.state === "idle");
    const result = (await entries(service, "a"))
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    if (result?.role !== "toolResult") throw new Error("no status result");
    expect(textOf(result.content)).toBe(`## b (idle)\nJob:\n${job}`);
  });

  test("a stopped agent refuses messages until the parent messages it", async () => {
    const service = await open();
    await service.spawnGraph({ agents: [spec("b", "idle")] });
    await until(() => service.get("b")?.state === "idle");
    await service.stop("b");
    await service.spawnGraph({ agents: [spec("a", SEND)] });
    await until(() => service.get("a")?.state === "idle");
    expect(service.get("a")?.result?.text).toBe(
      "tool: b was stopped and doesn't take messages from agents.",
    );
    expect(service.messages()).toEqual([]);
    // The parent reopens it, and agents can message it again.
    await service.send("b", "back", "steer");
    await until(() => service.get("b")?.state === "idle");
    await service.send("a", SEND, "steer");
    await until(() => service.messages().length === 1);
  });
});
