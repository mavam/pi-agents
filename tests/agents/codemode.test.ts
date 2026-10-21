import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ClassifierResult, createProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentService } from "../../src/agents/service.js";
import { closeService, hostOf, openService } from "./helpers.js";

const CONTEXT = BACKGROUND_CONTEXT;
const CLASSIFY = "pi.codemode.models.classify";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CLASSIFIER_USAGE = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { ...COST, input: 0.001, output: 0.0002, total: 0.0012 },
};

let services: AgentService[] = [];

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

function modelsWithClassifier() {
  const faux = fauxProvider();
  const models = createModels();
  faux.setResponses(
    Array.from({ length: 20 }, () => (context) => {
      const last = [...context.messages]
        .reverse()
        .find((message) => message.role !== "system");
      const text =
        typeof last?.content === "string"
          ? last.content
          : (last?.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("") ?? "");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
      return text.startsWith("script ")
        ? fauxAssistantMessage(
            [fauxToolCall("codemode", { code: text.slice(7) })],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }) as FauxResponseStep[],
  );
  models.setProvider(faux.provider);
  models.setProvider(
    createProvider({
      id: "test",
      auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
      models: [
        {
          id: "judge",
          name: "Judge",
          api: "test-classifier",
          provider: "test",
          baseUrl: "https://example.invalid",
          input: ["text"],
          cost: COST,
          type: "classifier",
          contextWindow: 1000,
        },
      ],
      classifiers: {
        "test-classifier": {
          classify: async (model): Promise<ClassifierResult> => ({
            api: model.api,
            provider: model.provider,
            model: model.id,
            answers: {
              good: { value: true },
            } as unknown as ClassifierResult["answers"],
            usage: CLASSIFIER_USAGE,
            stopReason: "stop",
            timestamp: 0,
          }),
        },
      },
    }),
  );
  return models;
}

describe("codemode models", () => {
  test("codemode scripts classify and include model usage", async () => {
    const service = await openService({ models: modelsWithClassifier() });
    services.push(service);
    const info = await service.spawnGraph({
      agents: [
        {
          name: "with-codemode",
          job: `script const model = await models.getModelOfType("classifier", "test", "judge");
        const result = await models.classify(model, {
          state: { text: "hello" },
          questions: { good: { type: "bool", instructions: "Good?", criteria: { true: "yes", false: "no" } } },
        });
        return result.answers.good.value;`,
          cwd: ".",
          model: { provider: "faux", modelId: "faux-1" },
          tools: ["codemode"],
        },
      ],
    });
    await service.wait([info.name]);
    expect(service.get(info.name)?.result?.text).toContain("true");
    expect(service.get(info.name)?.usage.cost).toBeCloseTo(0.0012);

    const plain = await service
      .spawnGraph({
        agents: [
          {
            name: "without-codemode",
            job: "plain",
            cwd: ".",
            model: { provider: "faux", modelId: "faux-1" },
            tools: ["read"],
          },
        ],
      })
      .then((graph) => graph.nodes[0]?.agentId ?? "");
    const conversation = await hostOf(service).harness.harness.conversation(
      Number(plain) as ConversationId,
      CONTEXT,
    );
    const resolved = await conversation?.agent(CONTEXT);
    expect(resolved?.callable.map((tool) => tool.name)).not.toContain(CLASSIFY);
    await expect(
      service.spawnGraph({
        agents: [
          {
            name: "internal-by-name",
            job: "plain",
            cwd: ".",
            tools: [CLASSIFY],
          },
        ],
      }),
    ).rejects.toThrow("Unknown tools");
  });
});
