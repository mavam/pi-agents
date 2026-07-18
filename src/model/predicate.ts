/**
 * Predicate algebra for `loop.until`: comparisons over dot-paths into a JSON
 * value, composed with and/or/not. Evaluation is total — a missing path never
 * throws, it just makes the leaf false (or true for `ne`/`empty`).
 */

import type { Predicate } from "./ast.js";
import { resolvePath } from "./interpolate.js";

/** Parse a predicate path: "" addresses the whole value, "a.b" navigates into it. */
function pathSegments(path: string): string[] {
  return path === "" ? [] : path.split(".");
}

function lookup(
  value: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  return resolvePath(value, pathSegments(path));
}

export function evaluatePredicate(
  predicate: Predicate,
  value: unknown,
): boolean {
  if ("eq" in predicate) {
    const [path, expected] = predicate.eq;
    const result = lookup(value, path);
    return result.found && result.value === expected;
  }
  if ("ne" in predicate) {
    const [path, expected] = predicate.ne;
    const result = lookup(value, path);
    return !result.found || result.value !== expected;
  }
  if ("gt" in predicate) {
    const [path, bound] = predicate.gt;
    const result = lookup(value, path);
    return (
      result.found && typeof result.value === "number" && result.value > bound
    );
  }
  if ("lt" in predicate) {
    const [path, bound] = predicate.lt;
    const result = lookup(value, path);
    return (
      result.found && typeof result.value === "number" && result.value < bound
    );
  }
  if ("exists" in predicate) {
    const result = lookup(value, predicate.exists);
    return result.found && result.value !== undefined;
  }
  if ("empty" in predicate) {
    const result = lookup(value, predicate.empty);
    if (!result.found || result.value === undefined || result.value === null)
      return true;
    if (typeof result.value === "string") return result.value === "";
    if (Array.isArray(result.value)) return result.value.length === 0;
    if (typeof result.value === "object")
      return Object.keys(result.value).length === 0;
    return false;
  }
  if ("and" in predicate) {
    return predicate.and.every((p) => evaluatePredicate(p, value));
  }
  if ("or" in predicate) {
    return predicate.or.some((p) => evaluatePredicate(p, value));
  }
  return !evaluatePredicate(predicate.not, value);
}

/** Render a predicate as a compact human-readable string for UI/errors. */
export function formatPredicate(predicate: Predicate): string {
  const path = (p: string) => (p === "" ? "." : p);
  if ("eq" in predicate)
    return `${path(predicate.eq[0])} == ${JSON.stringify(predicate.eq[1])}`;
  if ("ne" in predicate)
    return `${path(predicate.ne[0])} != ${JSON.stringify(predicate.ne[1])}`;
  if ("gt" in predicate) return `${path(predicate.gt[0])} > ${predicate.gt[1]}`;
  if ("lt" in predicate) return `${path(predicate.lt[0])} < ${predicate.lt[1]}`;
  if ("exists" in predicate) return `exists(${path(predicate.exists)})`;
  if ("empty" in predicate) return `empty(${path(predicate.empty)})`;
  if ("and" in predicate)
    return `(${predicate.and.map(formatPredicate).join(" && ")})`;
  if ("or" in predicate)
    return `(${predicate.or.map(formatPredicate).join(" || ")})`;
  return `!${formatPredicate(predicate.not)}`;
}
