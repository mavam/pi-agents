/** Per-harness request identity and optional extension payload hooks. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  type ConversationId,
  type Harness,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { AgentsDoc, type AgentsState } from "../agents/records.js";
import type { AgentHooks, ReadonlyAgentExtensionValue } from "../hooks.js";
import { freezeValue, hookError } from "./hook-state.js";

/** Await a hook without holding shutdown hostage to an uncooperative listener. */
async function abortable<T>(
  value: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return value;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([value, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class AgentRequestHooks {
  readonly models: Models;
  private agents: AgentsState["agents"] = {};
  private readonly identities = new Map<string, string>();
  private unsubscribe?: () => void;

  constructor(
    models: Models,
    private readonly sessionId: string,
    private readonly hooks: readonly AgentHooks[],
  ) {
    const streamSimple: Models["streamSimple"] = (model, context, options) => {
      const id = options?.sessionId && this.identities.get(options.sessionId);
      const agent = id ? this.agents[id] : undefined;
      if (!id || !agent) return models.streamSimple(model, context, options);
      const state = freezeValue(
        structuredClone(agent.extensionState ?? {}),
      ) as Record<string, ReadonlyAgentExtensionValue>;
      const identity = Object.freeze({ id, name: agent.name });
      const previous = options?.onPayload;
      const signal = options?.signal;
      return models.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, actualModel) => {
          signal?.throwIfAborted();
          if (previous) {
            const replacement = await abortable(
              Promise.resolve(previous(payload, actualModel)),
              signal,
            );
            if (replacement !== undefined) payload = replacement;
          }
          for (const hook of this.hooks) {
            if (!hook.onAgentRequest) continue;
            signal?.throwIfAborted();
            try {
              const replacement = await abortable(
                Promise.resolve(
                  hook.onAgentRequest(
                    {
                      sessionId: this.sessionId,
                      agent: identity,
                      model: Object.freeze({
                        provider: actualModel.provider,
                        api: actualModel.api,
                        id: actualModel.id,
                      }),
                      state: Object.hasOwn(state, hook.namespace)
                        ? state[hook.namespace]
                        : undefined,
                      signal,
                    },
                    payload,
                  ),
                ),
                signal,
              );
              if (replacement !== undefined) payload = replacement;
            } catch (error) {
              signal?.throwIfAborted();
              throw hookError(hook.namespace, "onAgentRequest", error);
            }
          }
          signal?.throwIfAborted();
          return payload;
        },
      });
    };
    const completeSimple: Models["completeSimple"] = (
      model,
      context,
      options,
    ) => streamSimple(model, context, options).result();
    this.models = new Proxy(models, {
      get(target, key) {
        if (key === "streamSimple") return streamSimple;
        if (key === "completeSimple") return completeSimple;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Must finish before service initialization can submit stored outbox work. */
  async start(harness: Harness): Promise<void> {
    const pending: CommitPublication[] = [];
    let bootstrapping = true;
    this.unsubscribe = harness.subscribeCommits((publication) => {
      if (bootstrapping) pending.push(publication);
      else this.adopt(publication);
    });
    this.agents =
      (await harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT))?.agents ?? {};
    const providers = await Promise.all(
      Object.keys(this.agents).map(
        async (id) =>
          [
            id,
            await harness.snapshot(
              ProviderDoc,
              Number(id) as ConversationId,
              BACKGROUND_CONTEXT,
            ),
          ] as const,
      ),
    );
    for (const [id, provider] of providers)
      if (provider) this.identities.set(provider.sessionId, id);
    for (const publication of pending) this.adopt(publication);
    bootstrapping = false;
  }

  private adopt(publication: CommitPublication): void {
    // Both halves of the join are updated before any later request can run.
    for (const change of publication.changes) {
      if (change.type !== "document") continue;
      if (change.record.kind === AgentsDoc.definition.kind)
        this.agents = (change.value as AgentsState | null)?.agents ?? {};
      else if (
        change.record.kind === ProviderDoc.definition.kind &&
        change.conversationId !== undefined
      ) {
        const id = String(change.conversationId);
        for (const [key, owner] of this.identities) {
          if (owner === id) this.identities.delete(key);
        }
        if (typeof change.value?.sessionId === "string")
          this.identities.set(change.value.sessionId, id);
      }
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.identities.clear();
    this.agents = {};
  }
}
