/** Optional lifecycle protocol for co-loaded Pi extensions. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SpawnSpec } from "./agents/types.js";

export type AgentExtensionValue =
  | null
  | boolean
  | number
  | string
  | AgentExtensionValue[]
  | { [key: string]: AgentExtensionValue };

export type AgentExtensionState = Record<string, AgentExtensionValue>;

export type ReadonlyAgentExtensionValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyAgentExtensionValue[]
  | { readonly [key: string]: ReadonlyAgentExtensionValue };

export interface AgentCreateContext {
  /** Resolved spawn input, before an ID or final name has been claimed. */
  readonly spec: Readonly<SpawnSpec>;
  readonly parent: {
    readonly sessionId: string;
    readonly branch: readonly SessionEntry[];
  };
}

export interface AgentRequestContext {
  /** Owning Pi session, not the provider's conversation identity. */
  readonly sessionId: string;
  readonly agent: { readonly id: string; readonly name: string };
  /** Actual dispatched model, after routing. */
  readonly model: {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
  };
  readonly state: ReadonlyAgentExtensionValue | undefined;
  readonly signal?: AbortSignal;
}

export interface AgentHooks {
  /** Stable extension-owned namespace. Also keys its persisted state. */
  readonly namespace: string;
  /** Synchronous and side-effect-free. Helpers inherit without calling it. */
  readonly onAgentCreate?: (
    ctx: AgentCreateContext,
  ) => AgentExtensionValue | undefined;
  /** Generation and compaction. May repeat; must be idempotent.
   * Undefined preserves the payload; any other value replaces it. */
  readonly onAgentRequest?: (
    ctx: AgentRequestContext,
    payload: unknown,
  ) => unknown | Promise<unknown>;
}

/** Respond synchronously from a listener registered during extension loading. */
export interface AgentHooksDiscovery {
  readonly protocol: 1;
  register(hooks: AgentHooks): void;
}

export const AGENT_HOOKS_DISCOVER = "pi-agents:hooks:discover";
