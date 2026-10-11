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
import type { DelegationLimits } from "../../src/agents/delegation.js";
import {
  type AgentExtensions,
  createAgentExtensions,
} from "../../src/agents/extensions.js";
import type { MessagingOptions } from "../../src/agents/messaging.js";
import {
  type Attention,
  AttentionSignals,
  type Handover,
  type Parent,
} from "../../src/agents/parent.js";
import { AgentService } from "../../src/agents/service.js";
import type { HelperResolver } from "../../src/agents/types.js";
import type { SkillSource } from "../../src/catalog/skills.js";
import { type AgentHarness, openAgentHarness } from "../../src/host/harness.js";

export const MODEL = { provider: "faux", modelId: "faux-1" };

/** How long test services gather commits before they refresh. */
export const TEST_REFRESH_MS = 5;

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

/** Resolves once the request aborts: a model that never finishes on its
 * own, so tests stop or interrupt it instead of racing it. */
export function heldUntilAborted(
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Resolves after `ms`, or earlier once the request aborts: a model that
 * works briefly, long enough for tests to see it working. */
export function briefly(
  signal: AbortSignal | undefined,
  ms = 200,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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

/**
 * A parent for tests that never takes deliveries, like a parent at work, so
 * tests inspect pending results and acknowledge them themselves. It holds
 * what `hold` gives it, such as a call's stored result.
 */
export class TestParent implements Parent {
  private readonly transcript = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly waits = new AttentionSignals();

  canDeliver(): boolean {
    return false;
  }

  async deliver(): Promise<void> {}

  async received(handovers: readonly Handover[]): Promise<ReadonlySet<string>> {
    return new Set(
      handovers.flatMap(({ id }) => (this.transcript.has(id) ? [id] : [])),
    );
  }

  /** The parent stored these results, such as with a call's result. */
  hold(ids: readonly string[]): void {
    for (const id of ids) this.transcript.add(id);
    this.notify();
  }

  attention(): Attention {
    return this.waits.open();
  }

  /** Something needs the parent: end its waits. */
  attend(): void {
    this.waits.raise();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export interface HostOptions {
  storage?: Storage;
  models?: ReturnType<typeof createFaux>["models"];
  /** The parent; a `TestParent` by default. */
  parent?: Parent;
  /** Whether the project is trusted, and its skills. */
  trusted?: boolean;
  skills?: SkillSource;
  delegationLimits?: Partial<DelegationLimits>;
  /** Turns messaging between agents on. */
  messaging?: MessagingOptions;
}

/** What a test host opened for a service: the harness and its anchor. */
export interface TestHost {
  service: AgentService;
  harness: AgentHarness;
  extensions: AgentExtensions;
  parent: Parent;
}

const hosts = new Map<AgentService, TestHost>();

export function testExtensions(options: HostOptions = {}): AgentExtensions {
  return createAgentExtensions({
    prompt: {
      trusted: () => options.trusted ?? false,
      skills: options.skills ?? (async () => []),
    },
    resolveHelper: inheritHelper,
    ...(options.delegationLimits
      ? { delegationLimits: options.delegationLimits }
      : {}),
    ...(options.messaging ? { messaging: options.messaging } : {}),
  });
}

/** A service on a harness that the test host opens like Pi's host does. */
export async function openService(
  options: HostOptions = {},
): Promise<AgentService> {
  const extensions = testExtensions(options);
  const harness = await openAgentHarness({
    storage: options.storage ?? new MemoryStorage(),
    models: options.models ?? createFaux().models,
    cwd: process.cwd(),
    extensions,
  });
  const parent = options.parent ?? new TestParent();
  try {
    const service = await AgentService.start({
      harness: harness.harness,
      anchor: harness.anchor,
      extensions,
      parent,
      messaging: () => options.messaging !== undefined,
      refreshDelayMs: TEST_REFRESH_MS,
    });
    harness.harness.resume();
    hosts.set(service, { service, harness, extensions, parent });
    return service;
  } catch (error) {
    await harness.close();
    throw error;
  }
}

export function hostOf(service: AgentService): TestHost {
  const host = hosts.get(service);
  if (!host) throw new Error("The service has no test host");
  return host;
}

/** The `TestParent` of a service opened without a parent of its own. */
export function parentOf(service: AgentService): TestParent {
  const parent = hostOf(service).parent;
  if (!(parent instanceof TestParent))
    throw new Error("The service has no test parent");
  return parent;
}

/** Close the service, then its harness, as the host does. */
export async function closeService(service: AgentService): Promise<void> {
  const host = hosts.get(service);
  hosts.delete(service);
  await service.close();
  await host?.harness.close();
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
