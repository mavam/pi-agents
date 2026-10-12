import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import {
  closeService,
  createFaux,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  until,
} from "./helpers.js";

// When agents and graphs ended, which stops their clocks.

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

async function open(
  options: Parameters<typeof openService>[0] = {},
): Promise<AgentService> {
  const service = await openService(options);
  services.push(service);
  return service;
}

async function reopen(
  service: AgentService,
  options: Parameters<typeof openService>[0],
): Promise<AgentService> {
  await closeService(service);
  services = services.filter((each) => each !== service);
  return open(options);
}

function endedAt(service: AgentService, name: string): number {
  const ended = service.get(name)?.endedAt;
  if (ended === undefined) throw new Error(`${name} has no end`);
  return ended;
}

/** A 1x1 red BMP, which `read` sends only once converted to PNG. */
function bmp(): Buffer {
  const file = Buffer.alloc(58);
  file.write("BM", 0);
  file.writeUInt32LE(58, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(1, 18);
  file.writeInt32LE(1, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(4, 34);
  file.set([0, 0, 255], 54);
  return file;
}

describe("runtime", () => {
  test("agents read images", async () => {
    const path = join(tempDir(), "red.bmp");
    writeFileSync(path, bmp());
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const step: FauxResponseStep = (context) => {
      const last = context.messages.at(-1);
      if (last?.role !== "toolResult")
        return fauxAssistantMessage([fauxToolCall("read", { path })], {
          stopReason: "toolUse",
        });
      const images = last.content.flatMap((block) =>
        block.type === "image" ? [block.mimeType] : [],
      );
      return fauxAssistantMessage(`saw ${images.join(", ") || "nothing"}`);
    };
    faux.setResponses([step, step]);
    const service = await open({ models });
    await service.spawn({ job: "look", name: "w", cwd: ".", model: MODEL });
    const outcome = await service.wait(["w"]);
    expect(outcome.agents[0]?.result?.text).toBe("saw image/png");
  });

  test("an agent ends when its answer streamed, also after reopening", async () => {
    const directory = tempDir();
    // About 300ms of streaming after the answer's timestamp.
    const { models } = createFaux((prompt) => `${prompt} `.repeat(60), {
      tokensPerSecond: 200,
    });
    const first = await open({
      storage: await jsonlStorage(directory),
      models,
    });
    await first.spawn({ job: "long", name: "w", cwd: ".", model: MODEL });
    await first.wait(["w"]);
    const ended = endedAt(first, "w");
    const info = first.get("w");
    expect(info?.state).toBe("idle");
    expect(ended - (info?.result?.at ?? ended)).toBeGreaterThan(100);

    const second = await reopen(first, {
      storage: await jsonlStorage(directory),
      models,
    });
    await until(() => second.get("w") !== undefined);
    expect(second.get("w")?.state).toBe("idle");
    expect(endedAt(second, "w")).toBe(ended);
  });

  test("a graph ends with its job, not with later messages", async () => {
    const directory = tempDir();
    const { models } = createFaux();
    const first = await open({
      storage: await jsonlStorage(directory),
      models,
    });
    await first.spawnGraph({
      name: "g",
      agents: [
        { job: "a", cwd: ".", model: MODEL },
        { job: "b", cwd: ".", model: MODEL },
      ],
    });
    await first.wait(["g"]);
    const graphEnd = first.getGraph("g")?.endedAt;
    expect(graphEnd).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    // A later message moves the agent's end, not the graph's.
    await first.prompt("g-1", "again", "auto");
    await until(() => first.get("g-1")?.result?.text === "done: [user] again");
    await until(() => (first.get("g-1")?.endedAt ?? 0) > (graphEnd ?? 0));
    expect(first.getGraph("g")?.endedAt).toBe(graphEnd);

    const second = await reopen(first, {
      storage: await jsonlStorage(directory),
      models,
    });
    await until(() => second.getGraph("g") !== undefined);
    expect(second.getGraph("g")?.endedAt).toBe(graphEnd);
    expect(endedAt(second, "g-1")).toBeGreaterThan(graphEnd ?? 0);
  });
});
