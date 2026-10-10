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
import type { AgentService } from "../../src/agents/service.js";
import { parseMessageInput } from "../../src/agents/types.js";
import { agentToolViews } from "../../src/ui/tool-views.js";
import {
  briefly,
  closeService,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "./helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("");
}

/**
 * `send <json>` calls agent_send, a message answers `got: <text>`, a tool
 * result `tool: <text>`, prompts and messages with `hold` wait until
 * aborted, and prompts with `briefly` work briefly.
 */
function scripted() {
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
    if (text.startsWith("send "))
      return fauxAssistantMessage(
        [fauxToolCall("agent_send", JSON.parse(text.slice(5)))],
        { stopReason: "toolUse" },
      );
    if (text.includes("hold")) await heldUntilAborted(options?.signal);
    if (text.includes("briefly")) await briefly(options?.signal, 300);
    const message = parseMessageInput(text);
    if (message) return fauxAssistantMessage(`got: ${message.text}`);
    return fauxAssistantMessage(`done: ${text}`);
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return models;
}

async function open(
  options: { storage?: Storage; messaging?: MessagingOptions } = {},
): Promise<AgentService> {
  const service = await openService({
    models: scripted(),
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

const spec = (name: string, task: string) => ({
  name,
  task,
  cwd: ".",
  model: MODEL,
});

const SEND = `send ${JSON.stringify({ to: "b", message: "hello" })}`;

describe("messaging", () => {
  test("a message reaches its recipient, and the answer stays there", async () => {
    const service = await open();
    await service.spawn(spec("b", "idle"));
    await until(() => service.get("b")?.state === "idle");
    await service.spawn(spec("a", SEND));
    await until(() => service.get("b")?.state === "idle");
    await until(() => service.messages()[0]?.status === "delivered");
    expect(service.get("a")?.result?.text).toBe("tool: Sent to b.");
    expect(service.messages()).toMatchObject([
      { from: { name: "a" }, to: { name: "b" }, text: "hello" },
    ]);
    // Only the agents' task answers wait for the parent.
    expect(
      service
        .pendingDeliveries()
        .map((delivery) =>
          delivery.kind === "agent" && delivery.outcome.kind === "answered"
            ? delivery.outcome.result.text
            : delivery.kind,
        )
        .sort(),
    ).toEqual(["done: idle", "tool: Sent to b."]);
  });

  test("a crash after logging delivers once, also once messaging is off", async () => {
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
    await before.spawn(spec("b", "idle"));
    await until(() => before.get("b")?.state === "idle");
    await before.spawn(spec("a", SEND));
    await until(() => held);

    const after = await reopen(before, directory, { enabled: () => false });
    await until(() => after.get("a")?.result?.text === "tool: Sent to b.");
    await until(() => after.get("b")?.result?.text === "got: hello");
    expect(count(await transcript(after, "b"), "[from a] hello")).toBe(1);
    expect(after.messages()).toMatchObject([{ text: "hello" }]);
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
    await before.spawn(spec("b", "idle"));
    await until(() => before.get("b")?.state === "idle");
    await before.spawn(spec("a", SEND));
    await until(() => held);
    // The bound agent stops, and another one takes its name.
    await before.stop("b");
    await before.spawn(spec("b", "idle again"));

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
    await service.spawn(spec("b", "idle"));
    await until(() => service.get("b")?.state === "idle");
    const hold = JSON.stringify({ to: "b", message: "hold on" });
    await service.spawn(spec("a", `send ${hold}`));
    await isLogged;
    const stopping = service.stop("b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await stopping;
    await until(() => service.get("b")?.state === "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.get("b")?.state).toBe("interrupted");
  });

  test("a steer joins the recipient's work, also the answer its parent gets", async () => {
    const service = await open();
    // b works in steps: a tool call, then its answer.
    await service.spawn(spec("b", "sleep"));
    await until(() => service.get("b")?.state === "working");
    await service.spawn(spec("a", SEND));
    await until(() => service.get("b")?.result?.text === "got: hello");
    const answers = service
      .pendingDeliveries()
      .flatMap((delivery) =>
        delivery.kind === "agent" && delivery.outcome.kind === "answered"
          ? [`${delivery.name}: ${delivery.outcome.result.text}`]
          : [],
      );
    expect(answers).toContain("b: got: hello");
  });

  test("interrupting a busy recipient drops its queued messages", async () => {
    const service = await open();
    await service.spawn(spec("b", "hold"));
    await until(() => service.get("b")?.state === "working");
    await service.spawn(spec("a", SEND));
    await until(() => service.messages()[0]?.status === "queued");
    await service.interrupt("b");
    await until(() => service.messages()[0]?.status === "dropped");
    expect(await transcript(service, "b")).not.toContain("[from a]");
  });

  test("agent_status lists the others with their tasks, as the attach view draws it", async () => {
    const service = await open();
    await service.spawn(spec("b", "Keep notes. Then rest."));
    await until(() => service.get("b")?.state === "idle");
    await service.spawn(spec("a", "status"));
    await until(() => service.get("a")?.state === "idle");
    const result = (await entries(service, "a"))
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    if (result?.role !== "toolResult") throw new Error("no status result");
    expect(textOf(result.content)).toBe(
      "## b (idle)\nTask:\nKeep notes. Then rest.",
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
    ).toEqual(["● b · faux-1 · Keep notes. Then rest."]);
  });

  test("a stopped agent refuses messages until the parent messages it", async () => {
    const service = await open();
    await service.spawn(spec("b", "idle"));
    await until(() => service.get("b")?.state === "idle");
    await service.stop("b");
    await service.spawn(spec("a", SEND));
    await until(() => service.get("a")?.state === "idle");
    expect(service.get("a")?.result?.text).toBe(
      "tool: b was stopped and doesn't take messages from agents.",
    );
    expect(service.messages()).toEqual([]);
    // The parent reopens it, and agents can message it again.
    await service.send("b", "back", "auto");
    await until(() => service.get("b")?.state === "idle");
    await service.send("a", SEND, "auto");
    await until(() => service.messages().length === 1);
  });
});
