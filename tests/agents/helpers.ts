import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { AgentService } from "../../src/agents/service.js";
import type { HelperResolver } from "../../src/agents/types.js";
import { createPromptExtension } from "../../src/host/prompt.js";
import { createToolsExtension } from "../../src/host/tools.js";

export const MODEL = { provider: "faux", modelId: "faux-1" };

/** The text of the newest user message in a request. */
export function lastUserText(
  context: Parameters<
    Extract<FauxResponseStep, (...args: never[]) => unknown>
  >[0],
): string {
  const last = [...context.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

/** A faux model that answers `answer(<prompt>)` for every request. */
export function createFaux(
  answer: (prompt: string) => string = (prompt) => `done: ${prompt}`,
  options: { tokensPerSecond?: number } = {},
) {
  const faux = fauxProvider({
    ...(options.tokensPerSecond
      ? { tokensPerSecond: options.tokensPerSecond }
      : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const step: FauxResponseStep = (context) =>
    fauxAssistantMessage(answer(lastUserText(context)));
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return { faux, models };
}

/**
 * A faux model that answers `done: <prompt>`, fails prompts that contain
 * `fail`, and holds prompts that contain `hold` until `release()` or until
 * the request aborts, so tests decide when work ends instead of racing it.
 */
export function createGatedFaux() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: FauxResponseStep = async (context, options) => {
    const prompt = lastUserText(context);
    if (prompt.includes("hold"))
      await new Promise<void>((resolve) => {
        void gate.then(resolve);
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    if (prompt.includes("fail"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `cannot ${prompt.split("\n")[0]}`,
      });
    return fauxAssistantMessage(`done: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return { models, release };
}

export function tempDir(prefix = "pi-agents-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function jsonlStorage(directory: string): Promise<Storage> {
  return openNodeJsonlStorage(directory, BACKGROUND_CONTEXT);
}

/** Helpers inherit their agent's settings and take only a tool allowlist;
 * the session host resolves profiles, models, and skills. */
export const inheritHelper: HelperResolver = async (request, defaults) => ({
  task: request.task,
  cwd: defaults.cwd,
  ...(defaults.model ? { model: defaults.model } : {}),
  ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
  ...(request.tools ? { tools: request.tools } : {}),
});

export async function openService(
  options: {
    storage?: Storage;
    models?: ReturnType<typeof createFaux>["models"];
  } = {},
): Promise<AgentService> {
  return AgentService.open({
    storage: options.storage ?? new MemoryStorage(),
    models: options.models ?? createFaux().models,
    cwd: process.cwd(),
    extensions: [
      createToolsExtension(),
      createPromptExtension({ trusted: () => false, skills: async () => [] }),
    ],
    resolveHelper: inheritHelper,
  });
}

export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
