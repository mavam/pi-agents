/**
 * Budget enforcement. Limits are immutable per run; the mutable agent
 * counter is serialized through a FIFO promise-chain mailbox so concurrent
 * parallel/map branches never race on it. The parallelism semaphore caps
 * simultaneously running agents globally across nested pools.
 */

import {
  type Budgets,
  DEFAULT_BUDGETS,
  type EffectiveBudgets,
} from "../model/ast.js";

export class BudgetExceededError extends Error {
  /** Last streamed output of the agent that was cut off, when one exists. */
  readonly partialText?: string;

  constructor(message: string, partialText?: string) {
    super(message);
    this.name = "BudgetExceededError";
    this.partialText = partialText;
  }
}

/** Validate user-supplied budgets: maxAgents is a non-negative integer,
 * other counts are positive integers, and durations/cost are positive finite
 * numbers. */
export function validateBudgets(budgets: Budgets | undefined): void {
  if (!budgets) return;
  const maxAgents = budgets.maxAgents;
  if (
    maxAgents !== undefined &&
    (typeof maxAgents !== "number" ||
      !Number.isInteger(maxAgents) ||
      maxAgents < 0)
  ) {
    throw new Error(
      `budget 'maxAgents' must be an integer >= 0 (got ${maxAgents})`,
    );
  }
  for (const key of [
    "maxDepth",
    "maxParallelism",
    "maxIterations",
    "maxTurns",
    "maxTokens",
  ] as const) {
    const value = budgets[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`budget '${key}' must be an integer >= 1 (got ${value})`);
    }
  }
  for (const key of ["maxAgentDuration", "maxDuration", "maxCost"] as const) {
    const value = budgets[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`budget '${key}' must be a number > 0 (got ${value})`);
    }
  }
}

/** Counting semaphore with direct slot hand-off (no wake-up races). */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.available = Math.max(1, slots);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // The releasing party handed its slot directly to us.
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

interface BudgetState {
  usedAgents: number;
  usedTokens: number;
  usedCost: number;
}

export class BudgetActor {
  /** Effective limits, immutable for the run's lifetime. */
  readonly limits: EffectiveBudgets;
  private readonly state: BudgetState = {
    usedAgents: 0,
    usedTokens: 0,
    usedCost: 0,
  };
  private mailbox: Promise<void> = Promise.resolve();

  constructor(limits?: Budgets) {
    this.limits = { ...DEFAULT_BUDGETS, ...(limits ?? {}) };
  }

  private send<T>(fn: (state: BudgetState) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mailbox = this.mailbox.then(() => {
        try {
          resolve(fn(this.state));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Atomically assert the depth budget and consume one agent slot. Runs as a
   * single mailbox message so assertion and mutation cannot interleave.
   */
  acquireAgent(depth: number): Promise<void> {
    return this.send((state) => {
      if (depth > this.limits.maxDepth) {
        throw new BudgetExceededError(
          `delegation depth budget exceeded (maxDepth: ${this.limits.maxDepth})`,
        );
      }
      if (state.usedAgents >= this.limits.maxAgents) {
        throw new BudgetExceededError(
          this.limits.maxAgents === 0
            ? "agent execution prohibited (maxAgents: 0)"
            : `agent budget exceeded (maxAgents: ${this.limits.maxAgents})`,
        );
      }
      state.usedAgents += 1;
    });
  }

  /** Per-node concurrency for a parallel/map pool (globally capped by the semaphore). */
  parallelismLimit(requested?: number): number {
    const cap = Math.max(1, this.limits.maxParallelism);
    return requested === undefined
      ? cap
      : Math.max(1, Math.min(requested, cap));
  }

  /** Effective iteration cap for a loop or while node. */
  iterationLimit(requested: number): number {
    return Math.min(requested, this.limits.maxIterations);
  }

  /**
   * Record streamed usage and assert the run-level token/cost budgets.
   * Deltas accumulate as agents report turns, so breaches surface at turn
   * granularity — the finest the providers report usage at.
   */
  recordUsage(delta: { tokens: number; cost: number }): Promise<void> {
    return this.send((state) => {
      state.usedTokens += delta.tokens;
      state.usedCost += delta.cost;
      const { maxTokens, maxCost } = this.limits;
      if (maxTokens !== undefined && state.usedTokens > maxTokens) {
        throw new BudgetExceededError(
          `token budget exceeded (maxTokens: ${maxTokens})`,
        );
      }
      if (maxCost !== undefined && state.usedCost > maxCost) {
        throw new BudgetExceededError(
          `cost budget exceeded (maxCost: $${maxCost})`,
        );
      }
    });
  }

  /** Total agent spawns consumed so far. */
  usedAgents(): Promise<number> {
    return this.send((state) => state.usedAgents);
  }
}
