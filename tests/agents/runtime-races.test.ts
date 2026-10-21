import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type ConversationId,
  GenerationTask,
  type Harness,
  hook,
  type TaskId,
  ToolTask,
} from "@earendil-works/pi-durable";
import { GraphsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  fauxModels,
  gate,
  type HostOptions,
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
const services: AgentService[] = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse())
    await closeService(service);
});

/** A service whose models answer with `step`, without retries, so a
 * failed request fails its run. */
async function open(step: FauxResponseStep, options: HostOptions = {}) {
  const service = await openService({
    models: fauxModels(step),
    settings: { retry: { enabled: false } },
    ...options,
  });
  services.push(service);
  return { service, harness: hostOf(service).harness.harness };
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

/** The groups agents spawned, oldest first. */
async function spawned(harness: Harness) {
  const graphs = (await harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {};
  return Object.values(graphs).filter((graph) => graph.owner !== undefined);
}

function lead(job: string) {
  return { name: "lead", job, spawn: true, cwd: ".", model: MODEL };
}

const spawn = (agents: Array<{ name: string; job: string }>) =>
  fauxAssistantMessage([fauxToolCall("agent_spawn", { agents })], {
    stopReason: "toolUse",
  });

const failure = (errorMessage: string) =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage });

/** The run that spawns fails: right after the spawn, after an answer it
 * continues past, or for want of a model. A quick correction must not hide
 * that failure from the group it spawned. */
test.each(["error", "continued answer", "missing model"] as const)(
  "a run that fails after a %s withdraws its group despite a quick correction",
  async (mode) => {
    const toolsFinished = gate();
    const continueRun = gate();
    const { service, harness } = await open(
      async (context, request) => {
        const last = context.messages.at(-1);
        const text = textOf(last?.content);
        if (text === "spawn then fail")
          return spawn([{ name: "child", job: "hold" }]);
        if (text === "hold") {
          await heldUntilAborted(request?.signal);
          return fauxAssistantMessage("aborted");
        }
        if (last?.role === "toolResult")
          return mode === "error"
            ? failure("run failed")
            : fauxAssistantMessage("not the end of the run");
        if (text === "continue to failure") return failure("continued failed");
        return fauxAssistantMessage(`answer: ${text}`);
      },
      {
        refreshDelayMs: 50,
        taskHooks: [
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
      const graph = await service.spawnGraph({ agents: [lead("initial")] });
      await service.wait(["lead"]);
      await service.send("lead", "spawn then fail", "steer");
      await toolsFinished.promise;
      const id = Number(graph.nodes[0]?.agentId) as ConversationId;
      const conversation = await harness.conversation(id, CONTEXT);
      const record = await harness.commit(
        (tx) => tx.submissionByRequest(id, "parent:1"),
        CONTEXT,
      );
      if (!conversation || !record) throw new Error("Missing request");
      const submission = await harness.submission(record.id, CONTEXT);
      if (mode === "missing model")
        await conversation.configure(
          { model: { provider: "missing", modelId: "missing" } },
          CONTEXT,
        );
      continueRun.release();
      expect((await submission?.wait(CONTEXT))?.status).toBe("unanswered");
      await conversation.configure({ model: MODEL }, CONTEXT);
      await service.prompt("lead", "rapid correction", "auto");
      await until(
        () =>
          service.get("lead")?.result?.text ===
          "answer: [user] rapid correction",
      );
      await until(async () =>
        (await spawned(harness)).some((graph) => graph.cancelled),
      );
      await until(async () => (await service.liveTasks()).length === 0);
    } finally {
      continueRun.release();
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
          messages.findLast((message) => message.role === "user")?.content,
        );
        return input === "unrelated failure"
          ? failure("request failed")
          : fauxAssistantMessage("checking");
      }
      if (text === "earlier request")
        return spawn([{ name: "c", job: "held child" }]);
      if (text === "unrelated failure")
        return spawn([{ name: "doomed", job: "doomed child" }]);
      return fauxAssistantMessage(`answer: ${text}`);
    };
    const directory = restart ? tempDir() : undefined;
    const storage = async () =>
      directory ? { storage: await jsonlStorage(directory) } : {};
    let { service, harness } = await open(step, await storage());
    try {
      await service.spawnGraph({
        agents: [lead(initialJob ? "earlier request" : "initial")],
      });
      if (!initialJob) {
        await until(() => service.pendingDeliveries().length > 0);
        for (const delivery of service.pendingDeliveries())
          await service.acknowledge(delivery);
        await service.send("lead", "earlier request", "steer");
      }
      await until(
        () =>
          service.get("lead")?.result?.text === "checking" &&
          service.get("lead.c")?.state === "working",
      );
      expect(service.pendingDeliveries()).toHaveLength(0);
      await service.send("lead", "unrelated failure", "steer");
      await until(() => service.get("lead")?.state === "failed");
      if (directory) {
        await closeService(service);
        ({ service, harness } = await open(step, await storage()));
      }
      await until(async () =>
        (await spawned(harness)).some((graph) => graph.cancelled),
      );
      expect((await spawned(harness)).map((graph) => graph.cancelled)).toEqual([
        undefined,
        true,
      ]);
      child.release();
      // The earlier work's result still settles what asked for it.
      await until(() =>
        service
          .pendingDeliveries()
          .some((delivery) =>
            (delivery.kind === "agent"
              ? [delivery.outcome]
              : delivery.nodes.map((node) => node.outcome)
            ).some(
              (outcome) =>
                outcome.kind === "answered" &&
                outcome.result.text.includes("preserved evidence"),
            ),
          ),
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
  const graphs = (await harness.snapshot(GraphsDoc, CONTEXT))?.graphs ?? {};
  const job = Object.keys(graphs).find((id) => !graphs[id]?.owner);
  // The failed job ends once its group did, after replaying its failure.
  await until(
    async () =>
      (await harness.getTask(Number(job) as TaskId, CONTEXT))?.state.status ===
      "terminal",
  );
  expect(
    (await spawned(harness)).map((graph) => [graph.name, graph.cancelled]),
  ).toEqual([
    ["lead.original", true],
    ["lead.retry", undefined],
  ]);
});

test("a withdrawn queued result arrives after the first corrective answer", async () => {
  let corrections = 0;
  const { service, harness } = await open(async (context, request) => {
    const last = context.messages.at(-1);
    const text = textOf(last?.content);
    if (text === "start") return spawn([{ name: "child", job: "child" }]);
    if (last?.role === "toolResult" && last.toolName === "agent_spawn") {
      await heldUntilAborted(request?.signal);
      return fauxAssistantMessage("interrupted");
    }
    if (text === "child") return fauxAssistantMessage("CHILD EVIDENCE");
    if (text === "[user] continue") corrections++;
    return fauxAssistantMessage(`final: ${text}`);
  });
  await service.spawnGraph({ agents: [lead("start")] });
  const child = async () => (await spawned(harness))[0];
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
  const pair = (await spawned(harness)).find(
    (graph) => graph.name === "lead.pair",
  );
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
  expect((await service.send(id, "follow up", "steer")).agent.id).toBe(id);
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
      if (tools.length === 0) return spawn([{ name: "c", job: "gated child" }]);
      if (tools.length === 1)
        return spawn([{ name: "d", job: "slow cleanup" }]);
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
      taskHooks: [
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
      const childGroup = service.get("lead.c")?.graph;
      await until(
        async () =>
          (await harness.getTask(Number(childGroup) as TaskId, CONTEXT))?.state
            .status === "terminal",
      );
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
      const presentations = async () =>
        (
          await conversation?.entries({}, 200, undefined, CONTEXT)
        )?.items.filter(
          (entry) =>
            entry.kind === "pi-agents.results" &&
            JSON.stringify(entry.model).includes("child evidence"),
        ) ?? [];
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
