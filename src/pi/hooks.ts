import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnSpec } from "../agents/types.js";
import {
  AGENT_HOOKS_DISCOVER,
  type AgentExtensionState,
  type AgentHooks,
  type AgentHooksDiscovery,
} from "../hooks.js";
import {
  copyExtensionValue,
  freezeValue,
  hookError,
} from "../host/hook-state.js";

/** The bus discovers callbacks; invoking them directly preserves failures. */
export function discoverAgentHooks(
  events: Pick<ExtensionAPI["events"], "emit">,
): readonly AgentHooks[] {
  const collected: unknown[] = [];
  let collecting = true;
  const request: AgentHooksDiscovery = {
    protocol: 1,
    register: (hooks) => {
      if (collecting) collected.push(hooks);
    },
  };
  try {
    events.emit(AGENT_HOOKS_DISCOVER, Object.freeze(request));
  } finally {
    collecting = false;
  }
  const namespaces = new Set<string>();
  const hooks = collected.map((value) => {
    if (typeof value !== "object" || value === null)
      throw new Error("Invalid agent hook registration");
    const candidate = value as AgentHooks;
    const { namespace, onAgentCreate, onAgentRequest } = candidate;
    if (
      typeof namespace !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(namespace) ||
      namespaces.has(namespace) ||
      (onAgentCreate !== undefined && typeof onAgentCreate !== "function") ||
      (onAgentRequest !== undefined && typeof onAgentRequest !== "function")
    )
      throw new Error(
        `Invalid or duplicate agent hook namespace: ${namespace}`,
      );
    namespaces.add(namespace);
    return Object.freeze({ namespace, onAgentCreate, onAgentRequest });
  });
  return Object.freeze(
    hooks.sort((a, b) =>
      a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0,
    ),
  );
}

/** Read the live branch at creation, not at discovery or session_start. */
export function captureAgentState(
  hooks: readonly AgentHooks[],
  ctx: ExtensionContext,
  spec: SpawnSpec,
): AgentExtensionState | undefined {
  if (!hooks.some((hook) => hook.onAgentCreate)) return undefined;
  const context = freezeValue({
    spec: structuredClone(spec),
    parent: {
      sessionId: ctx.sessionManager.getSessionId(),
      branch: structuredClone(ctx.sessionManager.getBranch()),
    },
  });
  const entries = hooks.flatMap((hook) => {
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
  if (entries.length === 0) return undefined;
  const state = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(state)) > 64 * 1024)
    throw new Error("Agent extension state exceeds 64 KiB");
  return state;
}
