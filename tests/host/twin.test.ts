import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import {
  agentSelection,
  installAgentExtensions,
} from "../../src/agents/extensions.js";
import { AgentService } from "../../src/agents/service.js";
import { ToolTwin } from "../../src/host/twin.js";
import { TwinCatalogDoc } from "../../src/host/twin-tools.js";
import {
  closeService,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  TEST_REFRESH_MS,
  TestParent,
  tempDir,
  testExtensions,
  until,
} from "../agents/helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

/** A Pi package whose extension registers `twin_echo`, as Webfox
 * registers its web tools, and `twin_ping` for scripts, as MCP does. */
function echoPackage(): string {
  const directory = tempDir("pi-agents-twin-");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "twin-echo", pi: { extensions: ["./echo.ts"] } }),
  );
  fs.writeFileSync(
    path.join(directory, "echo.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "twin_echo",
    label: "Echo",
    description: "Echo the text",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "echoing" }], details: {} });
      return { content: [{ type: "text", text: "echo: " + params.text }], details: { length: params.text.length } };
    },
  });
  // Declared only to codemode, as MCP's tools are by default.
  pi.registerTool({
    name: "twin_ping",
    label: "Ping",
    description: "Ping the twin",
    parameters: Type.Object({}),
    exposure: "codemode",
    namespace: { name: "twin", description: "The twin's tools" },
    async execute() {
      return { content: [{ type: "text", text: "pong" }], details: {} };
    },
  });
}
`,
  );
  return directory;
}

test("agents call the tools of the extensions the twin loads", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage([fauxToolCall("twin_echo", { text: "hi" })], {
        stopReason: "toolUse",
      });
    }),
  );
  const problems: string[] = [];
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
    onTwinProblem: (problem) => problems.push(problem),
  });
  services.push(service);
  // Naming a twin tool is fine: every agent has them all.
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "echo",
        cwd: ".",
        model: MODEL,
        tools: ["read", "twin_echo"],
      },
    ],
  });
  await service.wait(["a"]);
  expect(problems).toEqual([]);
  expect(service.get("a")?.result?.text).toBe("echo: hi");
  expect(service.get("a")?.tools).toEqual(["read"]);
});

test("agents without codemode load the twin's script tools with tool_search", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // Searches, calls what it loaded, then answers with its result.
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      // System messages, with their sections.
      prompts.push(
        JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        ),
      );
      const last = context.messages.at(-1);
      if (last?.role !== "toolResult")
        return fauxAssistantMessage(
          [fauxToolCall("tool_search", { query: "ping" })],
          { stopReason: "toolUse" },
        );
      if (last.toolName === "tool_search")
        return fauxAssistantMessage([fauxToolCall("twin_ping", {})], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(
        last.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
      );
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "ping", cwd: ".", model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toBe("pong");
  // The prompt names the namespace and how to reach its tools.
  expect(prompts[0]).toContain("Load their tools with `tool_search`");
  expect(prompts[0]).toContain("- twin: The twin's tools");
});

test("codemode lists the twin's namespaces and describes them", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      prompts.push(
        JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        ),
      );
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: 'return await describeNamespace("twin")',
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "describe",
        cwd: ".",
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await service.wait(["a"]);
  const result = service.get("a")?.result?.text ?? "";
  expect(result).toContain("The twin's tools");
  expect(result).toContain("twin_ping");
  expect(prompts[0]).toContain("## twin");
});

test("the twin's tools are stored for the next start", async () => {
  const service = await openService({
    storage: await jsonlStorage(tempDir("pi-agents-twin-store-")),
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  // Spawning waits for the twin's startup, after which it stores its tools.
  await service.spawnGraph({
    agents: [{ name: "a", job: "a", cwd: ".", model: MODEL }],
  });
  const harness = hostOf(service).harness.harness;
  await until(async () =>
    ((await harness.snapshot(TwinCatalogDoc, CONTEXT))?.tools ?? []).some(
      (tool) => tool.name === "twin_echo",
    ),
  );
});

test("calls of stored tools wait for the twin to start", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage([fauxToolCall("twin_echo", { text: "hi" })], {
        stopReason: "toolUse",
      });
    }),
  );
  // A host whose twin starts late, with the tools a previous start stored.
  const extensions = testExtensions();
  const registry = createRegistry();
  installAgentExtensions(registry, extensions);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: agentSelection(extensions) } },
    CONTEXT,
  );
  const twin = extensions.twin;
  twin.start();
  twin.restore(
    {
      tools: [
        {
          name: "twin_echo",
          description: "Echo the text",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          deferred: false,
          replaySafe: false,
        },
      ],
    },
    { persist: async () => {}, harness, report: () => {} },
  );
  const service = await AgentService.start({
    harness,
    anchor: await harness.root(CONTEXT),
    extensions,
    parent: new TestParent(),
    refreshDelayMs: TEST_REFRESH_MS,
  });
  harness.resume();
  let opened: ToolTwin | undefined;
  try {
    await service.spawnGraph({
      agents: [{ name: "a", job: "echo", cwd: ".", model: MODEL }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(service.get("a")?.state).toBe("working");
    opened = await ToolTwin.open({
      cwd: process.cwd(),
      extensions: [echoPackage()],
      trusted: false,
      onProblem: () => {},
    });
    twin.connect(opened);
    await service.wait(["a"]);
    expect(service.get("a")?.result?.text).toBe("echo: hi");
  } finally {
    await service.close();
    twin.detach();
    await harness.close(CONTEXT);
    await opened?.close();
  }
});
