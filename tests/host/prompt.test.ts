import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentService } from "../../src/agents/service.js";
import { discoverSkills } from "../../src/catalog/skills.js";
import { createPromptExtension } from "../../src/host/prompt.js";
import { createToolsExtension } from "../../src/host/tools.js";
import { inheritHelper, MODEL, tempDir, until } from "../agents/helpers.js";

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await service.close();
  services = [];
});

function skill(dir: string, name: string, frontmatter = ""): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill\n${frontmatter}---\nApply ${name}.\n`,
  );
}

/** A service whose model records each system prompt it receives. */
async function open(trusted: boolean) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 10 }, () => (context) => {
      // Pi-durable puts the system prompt's sections in a system message.
      const system = context.messages.find(
        (message) => (message.role as string) === "system",
      ) as { sections?: Record<string, string> } | undefined;
      prompts.push(Object.values(system?.sections ?? {}).join("\n"));
      return fauxAssistantMessage("done");
    }),
  );
  const service = await AgentService.open({
    storage: new MemoryStorage(),
    models,
    cwd: process.cwd(),
    extensions: [
      createToolsExtension(),
      createPromptExtension({ trusted: () => trusted, skills: discoverSkills }),
    ],
    resolveHelper: inheritHelper,
  });
  services.push(service);
  return { service, prompts };
}

describe("agent prompt", () => {
  const home = process.env.HOME as string;
  skill(path.join(home, ".agents", "skills"), "catalogued");
  skill(
    path.join(home, ".agents", "skills"),
    "manual",
    "disable-model-invocation: true\n",
  );
  const cwd = tempDir("pi-agents-prompt-");
  skill(path.join(cwd, ".pi", "skills"), "project-only");

  test("agents see the user's skill catalog, even in untrusted projects", async () => {
    const { service, prompts } = await open(false);
    await service.spawn({ task: "x", cwd, model: MODEL, tools: ["read"] });
    await until(() => prompts.length === 1);
    expect(prompts[0]).toContain("<name>catalogued</name>");
    expect(prompts[0]).not.toContain("<name>manual</name>");
    expect(prompts[0]).not.toContain("project-only");
  });

  test("trusted projects add their skills", async () => {
    const { service, prompts } = await open(true);
    await service.spawn({ task: "x", cwd, model: MODEL, tools: ["read"] });
    await until(() => prompts.length === 1);
    expect(prompts[0]).toContain("<name>project-only</name>");
  });

  test("chosen skills turn the catalog off", async () => {
    const { service, prompts } = await open(true);
    await service.spawn({
      task: "x",
      cwd,
      model: MODEL,
      tools: ["read"],
      ambientSkills: false,
    });
    await until(() => prompts.length === 1);
    expect(prompts[0]).not.toContain("<available_skills>");
  });
});
