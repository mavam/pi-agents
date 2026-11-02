import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  MODEL,
  openService,
  tempDir,
} from "../agents/helpers.js";

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
