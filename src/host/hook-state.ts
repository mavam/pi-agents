import type { AgentExtensionValue } from "../hooks.js";

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

export function hookError(
  namespace: string,
  hook: string,
  cause: unknown,
): Error {
  return new Error(`Agent extension ${namespace}: ${hook} failed`, { cause });
}
