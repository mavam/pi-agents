import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type ConversationId,
  GenerationTask,
  type HookRegistration,
  hook,
  MemoryStorage,
  type Storage,
  type TaskId,
  ToolTask,
} from "@earendil-works/pi-durable";
import { createAgentExtensions } from "../../src/agents/extensions.js";
import { GraphsDoc } from "../../src/agents/records.js";
import { AgentService } from "../../src/agents/service.js";
import { openAgentHarness } from "../../src/host/harness.js";
import {
  heldUntilAborted,
  inheritHelper,
  jsonlStorage,
  MODEL,
  TestParent,
  tempDir,
  until,
} from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Operation blocked")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ type: string; text?: string }>)
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("");
}

async function open(
  step: FauxResponseStep,
  options: {
    hooks?: HookRegistration[];
    storage?: Storage;
    refreshDelayMs?: number;
  } = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 200 }, () => step));
  const extensions = createAgentExtensions({
    prompt: { trusted: () => false, skills: async () => [] },
    resolveHelper: inheritHelper,
    hooks: options.hooks,
  });
  const host = await openAgentHarness({
    storage: options.storage ?? new MemoryStorage(),
    models,
    cwd: process.cwd(),
    extensions,
    settings: { retry: { enabled: false } },
  });
  const service = await AgentService.start({
    harness: host.harness,
    anchor: host.anchor,
    extensions,
    parent: new TestParent(),
    refreshDelayMs: options.refreshDelayMs ?? 5,
  });
  host.harness.resume();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
    await host.close();
  };
  cleanups.push(close);
  return { service, harness: host.harness, close };
}

function lead(job: string) {
  return { name: "lead", job, spawn: true, cwd: ".", model: MODEL };
}

test("a quick correction cannot hide a failed run's spawned work", async () => {
  const fail = gate();
  const entered = gate();
  const { service, harness } = await open(
    async (context, request) => {
      const last = context.messages.at(-1);
      const text = textOf(last?.content);
      if (text === "do work")
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "child", job: "hold" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text === "hold") {
        await heldUntilAborted(request?.signal);
        return fauxAssistantMessage("aborted child");
      }
      if (last?.role === "toolResult" && last.toolName === "agent_spawn") {
        entered.release();
        await Promise.race([fail.promise, heldUntilAborted(request?.signal)]);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "failed request",
        });
      }
      return fauxAssistantMessage(`final: ${text}`);
    },
    { refreshDelayMs: 50 },
  );
  try {
    const root = await service.spawnGraph({ agents: [lead("initial")] });
    await until(() => service.pendingDeliveries().length > 0);
    for (const delivery of service.pendingDeliveries())
      await service.acknowledge(delivery);
    await service.send("lead", "do work", "auto");
    await entered.promise;
    const record = await harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(root.nodes[0]?.agentId) as ConversationId,
          "parent:1",
        ),
      CONTEXT,
    );
    if (!record) throw new Error("Missing parent request");
    const submission = await harness.submission(record.id, CONTEXT);
    if (!submission) throw new Error("Missing submission");
    fail.release();
    await submission.wait(CONTEXT);
    await service.prompt("lead", "retry", "auto");
    await until(
      () => service.get("lead")?.result?.text === "final: [user] retry",
    );
    await until(async () => {
      const graphs = await harness.snapshot(GraphsDoc, CONTEXT);
      return Object.values(graphs?.graphs ?? {}).some(
        (graph) => graph.owner && graph.cancelled,
      );
    });
    await until(async () => (await service.liveTasks()).length === 0);
  } finally {
    fail.release();
  }
});

test.each(["continued answer", "missing model"] as const)(
  "cancellation follows the failed submission after a %s",
  async (failure) => {
    const toolsFinished = gate();
    const continueRun = gate();
    const host = await open(
      async (context, request) => {
        const last = context.messages.at(-1);
        const text = textOf(last?.content);
        if (text === "spawn then fail")
          return fauxAssistantMessage(
            [
              fauxToolCall("agent_spawn", {
                agents: [{ name: "child", job: "hold" }],
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (text === "hold") {
          await heldUntilAborted(request?.signal);
          return fauxAssistantMessage("aborted");
        }
        if (last?.role === "toolResult")
          return fauxAssistantMessage("not the end of the run");
        if (text === "continue to failure")
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "continued run failed",
          });
        return fauxAssistantMessage(`answer: ${text}`);
      },
      {
        refreshDelayMs: 50,
        hooks: [
          hook(GenerationTask, {
            afterTools: async () => {
              toolsFinished.release();
              await continueRun.promise;
            },
            onYield: (answer) =>
              textOf(answer.content) === "not the end of the run"
                ? { continue: "continue to failure" }
                : undefined,
          }),
        ],
      },
    );
    try {
      const graph = await host.service.spawnGraph({
        agents: [lead("initial")],
      });
      await host.service.wait(["lead"]);
      await host.service.send("lead", "spawn then fail", "auto");
      await toolsFinished.promise;
      const id = Number(graph.nodes[0]?.agentId) as ConversationId;
      const conversation = await host.harness.conversation(id, CONTEXT);
      const record = await host.harness.commit(
        (tx) => tx.submissionByRequest(id, "parent:1"),
        CONTEXT,
      );
      if (!conversation || !record) throw new Error("Missing request");
      const submission = await host.harness.submission(record.id, CONTEXT);
      if (failure === "missing model")
        await conversation.configure(
          { model: { provider: "missing", modelId: "missing" } },
          CONTEXT,
        );
      continueRun.release();
      expect((await submission?.wait(CONTEXT))?.status).toBe("unanswered");
      await conversation.configure({ model: MODEL }, CONTEXT);
      await host.service.prompt("lead", "rapid correction", "auto");
      await until(
        () =>
          host.service.get("lead")?.result?.text ===
          "answer: [user] rapid correction",
      );
      await until(async () =>
        Object.values(
          (await host.harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {},
        ).some(
          (graph) => graph.owner !== undefined && graph.cancelled === true,
        ),
      );
      await until(async () => (await host.service.liveTasks()).length === 0);
    } finally {
      continueRun.release();
    }
  },
  15_000,
);

test("a withdrawn queued result arrives after the first corrective answer", async () => {
  let corrections = 0;
  const { service, harness } = await open(async (context, request) => {
    const last = context.messages.at(-1);
    const text = textOf(last?.content);
    if (text === "start")
      return fauxAssistantMessage(
        [
          fauxToolCall("agent_spawn", {
            agents: [{ name: "child", job: "child" }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (last?.role === "toolResult" && last.toolName === "agent_spawn") {
      await heldUntilAborted(request?.signal);
      return fauxAssistantMessage("interrupted");
    }
    if (text === "child") return fauxAssistantMessage("CHILD EVIDENCE");
    if (text === "[user] continue") corrections++;
    return fauxAssistantMessage(`final: ${text}`);
  });
  await service.spawnGraph({ agents: [lead("start")] });
  const child = async () =>
    Object.values(
      (await harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {},
    ).find((graph) => graph.owner);
  await until(async () => {
    const graph = await child();
    return graph?.attempt !== undefined && graph.presented === undefined;
  });
  await service.interrupt("lead");
  await service.prompt("lead", "continue", "auto");
  await until(async () => (await child())?.presented !== undefined);
  await until(
    () => service.get("lead")?.result?.text.includes("CHILD EVIDENCE") === true,
  );
  expect(corrections).toBe(1);
});

test("a codemode script can immediately stop the group it spawned", async () => {
  let scriptResult: string | undefined;
  const { service, harness } = await open(async (context, request) => {
    const last = context.messages.at(-1);
    const text = textOf(last?.content);
    if (text === "start")
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: 'await tools.agent_spawn({name:"pair", agents:[{name:"a",job:"hold"},{name:"b",job:"hold"}]}); return await tools.agent_stop({name:"lead.pair"});',
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (text === "hold") {
      await heldUntilAborted(request?.signal);
      return fauxAssistantMessage("aborted");
    }
    if (last?.role === "toolResult" && last.toolName === "codemode")
      scriptResult = text;
    return fauxAssistantMessage(`final: ${text}`);
  });
  await service.spawnGraph({
    agents: [{ ...lead("start"), tools: ["codemode"] }],
  });
  await until(() => scriptResult !== undefined);
  expect(scriptResult).not.toContain("Script failed");
  const pair = Object.values(
    (await harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {},
  ).find((graph) => graph.name === "lead.pair");
  expect(pair?.stopped).toBe(true);
  await until(async () => (await service.liveTasks()).length === 0);
});

test("returned agent and graph IDs cannot be shadowed by numeric names", async () => {
  const { service } = await open(async (context) =>
    fauxAssistantMessage(`answer: ${textOf(context.messages.at(-1)?.content)}`),
  );
  const original = await service.spawnGraph({ agents: [lead("initial")] });
  const id = String(original.nodes[0]?.agentId);
  await service.wait([id]);
  const shadow = await service.spawnGraph({
    agents: [{ ...lead("shadow"), name: id }],
  });
  const graphShadow = await service.spawnGraph({
    agents: [{ ...lead("graph shadow"), name: original.id }],
  });
  await service.waitFor([
    { kind: "graph", id: shadow.id },
    { kind: "graph", id: graphShadow.id },
  ]);
  expect(service.find(id)?.info.id).toBe(id);
  expect(service.find(original.id)).toMatchObject({
    kind: "graph",
    info: { id: original.id },
  });
  expect((await service.send(id, "follow up", "auto")).id).toBe(id);
  const waited = await service.wait([id]);
  expect(waited.agents.map((agent) => agent.id)).toEqual([id]);
  expect((await service.stop(id)).info.id).toBe(id);
  expect(
    service.agentById(String(shadow.nodes[0]?.agentId))?.result?.text,
  ).toBe("answer: shadow");
});

/** Real tool hooks hold cleanup open, as an extension releasing external
 * resources can. No service, hub, task, or conversation is replaced. */
test.each(["interrupt", "stop"] as const)(
  "presentation skips a busy %s turn while its agent_stop finishes",
  async (operation) => {
    const child = gate();
    const childCleanup = gate();
    const ownerCleanup = gate();
    const childStarted = gate();
    const ownerStarted = gate();
    const childAborted = gate();
    const ownerAborted = gate();
    const step: FauxResponseStep = async (context, request) => {
      const messages = context.messages.filter(
        (message) => message.role !== "system",
      );
      const last = messages.at(-1);
      const first = textOf(
        messages.find((message) => message.role === "user")?.content,
      );
      const text = textOf(last?.content);
      if (first === "gated child") {
        await Promise.race([child.promise, heldUntilAborted(request?.signal)]);
        return fauxAssistantMessage("child evidence");
      }
      if (first === "slow cleanup")
        return fauxAssistantMessage(
          [fauxToolCall("read", { path: "child-cleanup" })],
          { stopReason: "toolUse" },
        );
      if (
        first !== "stop children" ||
        (last?.role === "user" && messages.length > 1)
      )
        return fauxAssistantMessage(`answer: ${text}`);
      const tools = messages.filter((message) => message.role === "toolResult");
      if (tools.length === 0)
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "c", job: "gated child" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (tools.length === 1)
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "d", job: "slow cleanup" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      await childStarted.promise;
      return fauxAssistantMessage(
        [
          fauxToolCall("agent_stop", { name: "d" }),
          fauxToolCall("read", { path: "owner-cleanup" }),
        ],
        { stopReason: "toolUse" },
      );
    };
    const { service, harness } = await open(step, {
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, _api, context) => {
            if (call.name !== "read") return;
            const childCall = call.arguments.path === "child-cleanup";
            (childCall ? childStarted : ownerStarted).release();
            await heldUntilAborted(context.abortSignal);
            (childCall ? childAborted : ownerAborted).release();
            await (childCall ? childCleanup : ownerCleanup).promise;
            return { block: "cleanup finished" };
          },
        }),
      ],
    });
    try {
      await service.spawnGraph({
        name: "team",
        agents: [
          lead("stop children"),
          { name: "peer", job: "idle", cwd: ".", model: MODEL },
        ],
      });
      // agent_stop is inside stopAgent, awaiting the child's actual abort.
      await Promise.all([childAborted.promise, ownerStarted.promise]);
      const interrupted: Promise<unknown> =
        operation === "interrupt"
          ? service.interrupt("lead")
          : service.stop("lead");
      await ownerAborted.promise;
      child.release();
      await until(
        () => service.get("lead.c")?.result?.text === "child evidence",
      );
      await until(async () => {
        const graphs = await harness.snapshot(GraphsDoc, CONTEXT);
        const group = Object.entries(graphs?.graphs ?? {}).find(([, graph]) =>
          graph.nodes.some((node) => node.agent === service.get("lead.c")?.id),
        );
        return (
          group !== undefined &&
          (await harness.getTask(Number(group[0]) as TaskId, CONTEXT))?.state
            .status === "terminal"
        );
      });
      // An unrelated operation must finish even while lead holds its turn.
      const unrelated = await within(
        service.spawnGraph({
          agents: [{ name: "other", job: "unrelated", cwd: ".", model: MODEL }],
        }),
      );
      expect(unrelated.name).toBe("other");
      // Once unrelated commits settle, a blocked presentation must sleep,
      // not keep refreshing until the cleanup eventually releases its turn.
      let refreshes = 0;
      const unsubscribe = service.subscribe(() => refreshes++);
      await Bun.sleep(50);
      const quiet = refreshes;
      await Bun.sleep(75);
      unsubscribe();
      expect(refreshes).toBe(quiet);
      ownerCleanup.release();
      // Interrupting the tool caller must not join the descendant's cleanup.
      // The stop operation itself continues independently after cancellation.
      if (operation === "interrupt") await within(interrupted);
      childCleanup.release();
      await within(interrupted);
      if (operation === "stop") {
        expect(service.get("lead")?.closed).toBe(true);
        await until(async () => (await service.liveTasks()).length === 0);
        return;
      }
      await service.prompt("lead", "continue", "auto");
      const id = Number(service.get("lead")?.id) as ConversationId;
      const conversation = await harness.conversation(id, CONTEXT);
      const presentations = async () => {
        const entries = await conversation?.entries(
          {},
          200,
          undefined,
          CONTEXT,
        );
        return (
          entries?.items.filter(
            (entry) =>
              entry.kind === "pi-agents.results" &&
              JSON.stringify(entry.model).includes("child evidence"),
          ) ?? []
        );
      };
      await until(async () => (await presentations()).length > 0);
      await until(async () => (await service.liveTasks()).length === 0);
      expect(await presentations()).toHaveLength(1);
    } finally {
      child.release();
      childCleanup.release();
      ownerCleanup.release();
    }
  },
  15_000,
);

for (const { restart, initialJob } of [
  { restart: false, initialJob: false },
  { restart: true, initialJob: false },
  { restart: false, initialJob: true },
]) {
  test(`an unrelated failure preserves an earlier ${initialJob ? "graph job" : "parent request"}${restart ? " across restart" : ""}`, async () => {
    const child = gate();
    const step: FauxResponseStep = async (context, request) => {
      const messages = context.messages.filter(
        (message) => message.role !== "system",
      );
      const last = messages.at(-1);
      const text = textOf(last?.content);
      if (text === "held child") {
        await Promise.race([child.promise, heldUntilAborted(request?.signal)]);
        return fauxAssistantMessage("preserved evidence");
      }
      if (text === "doomed child") {
        await heldUntilAborted(request?.signal);
        return fauxAssistantMessage("aborted");
      }
      if (last?.role === "toolResult") {
        const input = textOf(
          [...messages].reverse().find((message) => message.role === "user")
            ?.content,
        );
        return input === "unrelated failure"
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "request failed",
            })
          : fauxAssistantMessage("checking");
      }
      if (text === "earlier request")
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "c", job: "held child" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (text === "unrelated failure")
        return fauxAssistantMessage(
          [
            fauxToolCall("agent_spawn", {
              agents: [{ name: "doomed", job: "doomed child" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(`answer: ${text}`);
    };
    const directory = restart ? tempDir() : undefined;
    let host = await open(step, {
      storage: directory ? await jsonlStorage(directory) : undefined,
    });
    try {
      await host.service.spawnGraph({
        agents: [lead(initialJob ? "earlier request" : "initial")],
      });
      if (!initialJob) {
        await until(() => host.service.pendingDeliveries().length > 0);
        for (const delivery of host.service.pendingDeliveries())
          await host.service.acknowledge(delivery);
        await host.service.send("lead", "earlier request", "auto");
      }
      await until(
        () =>
          host.service.get("lead")?.result?.text === "checking" &&
          host.service.get("lead.c")?.state === "working",
      );
      expect(host.service.pendingDeliveries()).toHaveLength(0);
      await host.service.send("lead", "unrelated failure", "auto");
      await until(() => host.service.get("lead")?.state === "failed");
      if (directory) {
        await host.close();
        host = await open(step, { storage: await jsonlStorage(directory) });
      }
      const graphs = await host.harness.snapshot(GraphsDoc, CONTEXT);
      const spawned = Object.values(graphs?.graphs ?? {}).filter(
        (graph) => graph.owner !== undefined,
      );
      expect(spawned).toHaveLength(2);
      expect(spawned[0]?.cancelled).not.toBe(true);
      await until(async () => {
        const graphs = await host.harness.snapshot(GraphsDoc, CONTEXT);
        return Object.values(graphs?.graphs ?? {}).some(
          (graph) => graph.owner !== undefined && graph.cancelled,
        );
      });
      const settled = Object.values(
        (await host.harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {},
      ).filter((graph) => graph.owner !== undefined);
      expect(settled[0]?.cancelled).not.toBe(true);
      expect(settled[1]?.cancelled).toBe(true);
      child.release();
      await until(
        () =>
          host.service
            .get("lead")
            ?.result?.text.includes("preserved evidence") === true,
      );
      await until(() =>
        host.service.pendingDeliveries().some((delivery) => {
          const outcomes =
            delivery.kind === "agent"
              ? [delivery.outcome]
              : delivery.nodes.map((node) => node.outcome);
          return outcomes.some(
            (outcome) =>
              outcome.kind === "answered" &&
              outcome.result.text.includes("preserved evidence"),
          );
        }),
      );
    } finally {
      child.release();
    }
  }, 15_000);
}

test("a failed job's recovery withdraws only the failed run's groups", async () => {
  // The worker's failed job still drains its group when the process dies;
  // meanwhile a retry spawned another group.
  const directory = tempDir();
  const worker = fileURLToPath(new URL("./fail-worker.ts", import.meta.url));
  const crashed = Bun.spawn(["bun", worker, directory], { stdout: "ignore" });
  expect(await crashed.exited).toBe(0);
  const { harness } = await open(
    async (_context, request) => {
      await heldUntilAborted(request?.signal);
      return fauxAssistantMessage("aborted");
    },
    { storage: await jsonlStorage(directory) },
  );
  const graphs = async () =>
    Object.entries((await harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {});
  const [job] = (await graphs()).filter(([, graph]) => !graph.owner);
  // The failed job ends once its group did, after replaying its failure.
  await until(
    async () =>
      (await harness.getTask(Number(job?.[0]) as TaskId, CONTEXT))?.state
        .status === "terminal",
  );
  const spawned = (await graphs()).filter(([, graph]) => graph.owner);
  expect(spawned.map(([, graph]) => [graph.name, graph.cancelled])).toEqual([
    ["lead.original", true],
    ["lead.retry", undefined],
  ]);
});
