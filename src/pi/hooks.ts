import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_HOOKS_DISCOVER,
  type AgentCreateContext,
  type AgentExtensionState,
  type AgentHooks,
  type AgentHooksDiscovery,
} from "../hooks.js";
import {
  copyExtensionValue,
  freezeValue,
  hookError,
  MAX_EXTENSION_STATE_BYTES,
} from "../host/hook-state.js";

const NAMESPACE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

export interface AgentHookDiscovery {
  /** Valid registrations, in lexicographic namespace order. */
  hooks: readonly AgentHooks[];
  /** Why registrations were ignored, for one notice. */
  problems: string[];
}

/** A short, printable name for a namespace that may be anything. */
function label(namespace: unknown): string {
  const text = typeof namespace === "string" ? namespace : String(namespace);
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 63)}…` : text);
}

/**
 * Ask co-loaded extensions for their hooks. The bus only discovers them;
 * invoking callbacks directly preserves their failures. An invalid
 * registration is ignored, and so is every registration of a namespace
 * that several claim: nobody can tell which owns its stored state, so none
 * applies it, as if its extension were absent.
 */
export function discoverAgentHooks(
  events: Pick<ExtensionAPI["events"], "emit">,
): AgentHookDiscovery {
  const collected: unknown[] = [];
  const problems: string[] = [];
  let collecting = true;
  const request: AgentHooksDiscovery = {
    protocol: 1,
    register: (hooks) => {
      if (collecting) collected.push(hooks);
    },
  };
  try {
    events.emit(AGENT_HOOKS_DISCOVER, Object.freeze(request));
  } catch (error) {
    problems.push(
      `discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    collecting = false;
  }
  const valid: AgentHooks[] = [];
  for (const value of collected) {
    const candidate = (
      typeof value === "object" && value !== null ? value : {}
    ) as Partial<AgentHooks>;
    const { namespace, onAgentCreate, onAgentRequest } = candidate;
    if (
      typeof namespace !== "string" ||
      !NAMESPACE.test(namespace) ||
      (onAgentCreate !== undefined && typeof onAgentCreate !== "function") ||
      (onAgentRequest !== undefined && typeof onAgentRequest !== "function")
    ) {
      problems.push(`invalid registration ${label(namespace)}`);
      continue;
    }
    valid.push(Object.freeze({ namespace, onAgentCreate, onAgentRequest }));
  }
  const counts = new Map<string, number>();
  for (const hook of valid)
    counts.set(hook.namespace, (counts.get(hook.namespace) ?? 0) + 1);
  for (const [namespace, count] of counts)
    if (count > 1) problems.push(`duplicate namespace ${label(namespace)}`);
  const hooks = valid
    .filter((hook) => counts.get(hook.namespace) === 1)
    .sort((a, b) =>
      a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0,
    );
  return { hooks: Object.freeze(hooks), problems };
}

/**
 * Capture every extension's state for one spawn: a single agent, or a
 * whole graph whose nodes share the snapshot. Callbacks are synchronous,
 * so the branch read here is the branch at creation. It is detached and
 * frozen only if a callback reads it, and then once for all of them.
 */
export function captureAgentState(
  hooks: readonly AgentHooks[],
  ctx: ExtensionContext,
): AgentExtensionState | undefined {
  if (!hooks.some((hook) => hook.onAgentCreate)) return undefined;
  const entries = ctx.sessionManager.getBranch();
  let branch: readonly SessionEntry[] | undefined;
  const context: AgentCreateContext = Object.freeze({
    parent: Object.freeze({
      sessionId: ctx.sessionManager.getSessionId(),
      get branch() {
        branch ??= freezeValue(structuredClone(entries));
        return branch;
      },
    }),
  });
  const captured = hooks.flatMap((hook) => {
    if (!hook.onAgentCreate) return [];
    try {
      const value = hook.onAgentCreate(context);
      return value === undefined
        ? []
        : [[hook.namespace, copyExtensionValue(value)] as const];
    } catch (error) {
      throw hookError(hook.namespace, "onAgentCreate", error);
    }
  });
  if (captured.length === 0) return undefined;
  const state = Object.fromEntries(captured);
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_EXTENSION_STATE_BYTES)
    throw new Error(
      `Agent extension state exceeds ${MAX_EXTENSION_STATE_BYTES / 1024} KiB`,
    );
  return state;
}
