/** Optional lifecycle protocol for co-loaded Pi extensions. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
  readonly parent: {
    readonly sessionId: string;
    /** The active branch at creation, detached and frozen on first read. */
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
  /** Synchronous and side-effect-free. Runs once per spawn: a graph's
   * nodes share one snapshot, and helpers inherit without calling it. */
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
