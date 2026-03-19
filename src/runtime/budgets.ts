import type { Budgets } from "./types.js";

/**
 * Internal snapshot — only the actor may read or write this.
 */
interface BudgetSnapshot {
  limits: Budgets;
  usedChildren: number;
}

// --- Pure helpers (private to this module) ---

function assertDepth(snapshot: BudgetSnapshot, depth: number): void {
  const maxDepth = snapshot.limits.maxDepth;
  if (maxDepth !== undefined && depth > maxDepth) {
    throw new Error(`Run depth budget exceeded (${maxDepth}).`);
  }
}

function consumeChild(snapshot: BudgetSnapshot): void {
  snapshot.usedChildren += 1;
  const maxChildren = snapshot.limits.maxChildren;
  if (maxChildren !== undefined && snapshot.usedChildren > maxChildren) {
    throw new Error(`Run child budget exceeded (${maxChildren}).`);
  }
}

function parallelismLimit(
  snapshot: BudgetSnapshot,
  requested?: number,
): number {
  const maxParallelism = snapshot.limits.maxParallelism;
  if (requested === undefined && maxParallelism === undefined) return 4;
  if (requested === undefined) return Math.max(1, maxParallelism ?? 1);
  if (maxParallelism === undefined) return Math.max(1, requested);
  return Math.max(1, Math.min(requested, maxParallelism));
}

function loopIterationLimit(
  snapshot: BudgetSnapshot,
  requested: number,
): number {
  const maxIterations = snapshot.limits.maxIterations;
  if (maxIterations === undefined) return requested;
  return Math.min(requested, maxIterations);
}

// --- Actor ---

/**
 * Serializes every budget operation through a FIFO promise chain so that
 * concurrent fork branches never observe or mutate shared state at the same
 * time.  Each public method sends a "message" to the mailbox; the actor
 * processes messages one at a time, in order.
 */
export class BudgetActor {
  private readonly state: BudgetSnapshot;
  private mailbox: Promise<void> = Promise.resolve();

  constructor(limits?: Budgets) {
    this.state = {
      limits: { ...(limits ?? {}) },
      usedChildren: 0,
    };
  }

  /**
   * Enqueue a synchronous function on the mailbox and return a promise that
   * resolves with its return value (or rejects with its error) once the
   * function has been processed in FIFO order.
   */
  private send<T>(fn: (snapshot: BudgetSnapshot) => T): Promise<T> {
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
   * Atomically assert that the depth budget is not exceeded *and* consume a
   * child slot.  Both checks run inside a single message so no interleaving
   * can occur between the assertion and the mutation.
   */
  acquireSpawn(depth: number): Promise<void> {
    return this.send((s) => {
      assertDepth(s, depth);
      consumeChild(s);
    });
  }

  /** Read the effective parallelism limit. */
  getParallelismLimit(requested?: number): Promise<number> {
    return this.send((s) => parallelismLimit(s, requested));
  }

  /** Read the effective loop iteration limit. */
  getLoopIterationLimit(requested: number): Promise<number> {
    return this.send((s) => loopIterationLimit(s, requested));
  }

  /** Snapshot the current limits (for env propagation to subprocesses). */
  limits(): Promise<Budgets> {
    return this.send((s) => ({ ...s.limits }));
  }
}
