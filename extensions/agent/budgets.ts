import type { Budgets } from "./types.js";

export interface BudgetSnapshot {
  limits: Budgets;
  usedChildren: number;
}

export function createBudgetSnapshot(limits?: Budgets): BudgetSnapshot {
  return {
    limits: { ...(limits ?? {}) },
    usedChildren: 0,
  };
}

export function cloneBudgetSnapshot(snapshot: BudgetSnapshot): BudgetSnapshot {
  return {
    limits: { ...snapshot.limits },
    usedChildren: snapshot.usedChildren,
  };
}

export function consumeChild(snapshot: BudgetSnapshot): void {
  snapshot.usedChildren += 1;
  const maxChildren = snapshot.limits.maxChildren;
  if (maxChildren !== undefined && snapshot.usedChildren > maxChildren) {
    throw new Error(`Run child budget exceeded (${maxChildren}).`);
  }
}

export function assertDepth(snapshot: BudgetSnapshot, depth: number): void {
  const maxDepth = snapshot.limits.maxDepth;
  if (maxDepth !== undefined && depth > maxDepth) {
    throw new Error(`Run depth budget exceeded (${maxDepth}).`);
  }
}

export function getParallelismLimit(
  snapshot: BudgetSnapshot,
  requested?: number,
): number {
  const maxParallelism = snapshot.limits.maxParallelism;
  if (requested === undefined && maxParallelism === undefined) return 4;
  if (requested === undefined) return Math.max(1, maxParallelism ?? 1);
  if (maxParallelism === undefined) return Math.max(1, requested);
  return Math.max(1, Math.min(requested, maxParallelism));
}

export function getLoopIterationLimit(
  snapshot: BudgetSnapshot,
  requested: number,
): number {
  const maxIterations = snapshot.limits.maxIterations;
  if (maxIterations === undefined) return requested;
  return Math.min(requested, maxIterations);
}
