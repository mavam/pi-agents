/**
 * Budget enforcement. Operations are serialized through a FIFO promise-chain
 * mailbox so concurrent par/map branches never race on shared counters.
 */

import { type Budgets, DEFAULT_BUDGETS } from "../model/ast.js";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

interface BudgetState {
  limits: Required<Budgets>;
  usedAgents: number;
}

export class BudgetActor {
  private readonly state: BudgetState;
  private mailbox: Promise<void> = Promise.resolve();

  constructor(limits?: Budgets) {
    this.state = {
      limits: { ...DEFAULT_BUDGETS, ...(limits ?? {}) },
      usedAgents: 0,
    };
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
      if (depth > state.limits.maxDepth) {
        throw new BudgetExceededError(
          `delegation depth budget exceeded (maxDepth: ${state.limits.maxDepth})`,
        );
      }
      state.usedAgents += 1;
      if (state.usedAgents > state.limits.maxAgents) {
        throw new BudgetExceededError(
          `agent budget exceeded (maxAgents: ${state.limits.maxAgents})`,
        );
      }
    });
  }

  /** Effective concurrency for a par/map node. */
  parallelismLimit(requested?: number): Promise<number> {
    return this.send((state) => {
      const cap = Math.max(1, state.limits.maxParallelism);
      return requested === undefined
        ? cap
        : Math.max(1, Math.min(requested, cap));
    });
  }

  /** Effective iteration cap for a loop node. */
  iterationLimit(requested: number): Promise<number> {
    return this.send((state) =>
      Math.min(requested, state.limits.maxIterations),
    );
  }

  /** Total agent spawns consumed so far. */
  usedAgents(): Promise<number> {
    return this.send((state) => state.usedAgents);
  }

  /** Current limits, for env propagation to children. */
  limits(): Promise<Required<Budgets>> {
    return this.send((state) => ({ ...state.limits }));
  }
}
