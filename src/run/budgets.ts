/**
 * Budget enforcement. Limits are immutable per run; the mutable agent
 * counter is serialized through a FIFO promise-chain mailbox so concurrent
 * parallel/map branches never race on it. The parallelism semaphore caps
 * simultaneously running agents globally across nested pools.
 */

import { type Budgets, DEFAULT_BUDGETS } from "../model/ast.js";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Validate user-supplied budgets: every field a positive integer. */
export function validateBudgets(budgets: Budgets | undefined): void {
  if (!budgets) return;
  for (const key of [
    "maxDepth",
    "maxParallelism",
    "maxIterations",
    "maxAgents",
  ] as const) {
    const value = budgets[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`budget '${key}' must be an integer >= 1 (got ${value})`);
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
}

export class BudgetActor {
  /** Effective limits, immutable for the run's lifetime. */
  readonly limits: Required<Budgets>;
  private readonly state: BudgetState = { usedAgents: 0 };
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
      state.usedAgents += 1;
      if (state.usedAgents > this.limits.maxAgents) {
        throw new BudgetExceededError(
          `agent budget exceeded (maxAgents: ${this.limits.maxAgents})`,
        );
      }
    });
  }

  /** Per-node concurrency for a parallel/map pool (globally capped by the semaphore). */
  parallelismLimit(requested?: number): number {
    const cap = Math.max(1, this.limits.maxParallelism);
    return requested === undefined
      ? cap
      : Math.max(1, Math.min(requested, cap));
  }

  /** Effective iteration cap for a loop node. */
  iterationLimit(requested: number): number {
    return Math.min(requested, this.limits.maxIterations);
  }

  /** Total agent spawns consumed so far. */
  usedAgents(): Promise<number> {
    return this.send((state) => state.usedAgents);
  }
}
