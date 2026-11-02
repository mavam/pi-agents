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
 * registers its web tools. */
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
