import { describe, expect, it } from "bun:test";
import { KIND_ICONS, STATUS_ICONS } from "../extensions/agent/state.ts";

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

describe("icon registries", () => {
  it("uses unique symbols within kind icons", () => {
    const duplicates = duplicateValues(Object.values(KIND_ICONS));
    expect(duplicates).toEqual([]);
  });

  it("uses unique symbols within status icons", () => {
    const duplicates = duplicateValues(Object.values(STATUS_ICONS));
    expect(duplicates).toEqual([]);
  });

  it("does not overlap kind and status symbols", () => {
    const kindSymbols = new Set(Object.values(KIND_ICONS));
    const overlap = Object.values(STATUS_ICONS)
      .filter((symbol) => kindSymbols.has(symbol))
      .sort();
    expect(overlap).toEqual([]);
  });
});
