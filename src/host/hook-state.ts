import type { AgentExtensionValue } from "../hooks.js";

/** Every agent's state lives in one shared document, so keep it small. */
export const MAX_EXTENSION_STATE_BYTES = 8 * 1024;

/** Longest error detail a hook failure carries into the agent's error. */
const MAX_DETAIL = 300;

/** Strict JSON: serialization must not silently lose or change state. */
export function copyExtensionValue(value: unknown): AgentExtensionValue {
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): AgentExtensionValue => {
    if (depth > 32) throw new Error("Extension state exceeds depth 32");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw new Error("Extension state must be acyclic JSON");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error(
        "Extension state must contain only plain objects and arrays",
      );
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error("Extension state must not contain symbol keys");
    ancestors.add(item);
    try {
      if (Array.isArray(item))
        return Array.from(item, (child) => copy(child, depth + 1));
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          copy(child, depth + 1),
        ]),
      );
    } finally {
      ancestors.delete(item);
    }
  };
  return copy(value, 0);
}

/** Only use on detached data, never on a durable transaction's draft. */
export function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Name the namespace and hook, plus the message of a thrown error or string.
 * Other thrown values may hold state or payloads, so only `cause` keeps them.
 */
export function hookError(
  namespace: string,
  hook: string,
  cause: unknown,
): Error {
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  const detail = raw.replace(/\s+/g, " ").trim();
  const suffix = !detail
    ? ""
    : `: ${detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail}`;
  return new Error(`Agent extension ${namespace}: ${hook} failed${suffix}`, {
    cause,
  });
}
