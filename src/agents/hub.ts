/**
 * What the messaging tools share with the service in one process, which
 * owns the store: a turn order per recipient, so a send and a stop of the
 * same agent never interleave, the service's view of agents' states, and
 * its stops.
 */

import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { AgentState, TargetRef } from "./types.js";

export class MessagingHub {
  private readonly turns = new Map<string, Promise<unknown>>();
  private readonly retries = new Map<string, () => void>();

  /** An agent's state as the service derives it; the service sets it. */
  state: (agentId: string) => AgentState | undefined = () => undefined;

  /** Stop an agent or a group for an agent's `agent_stop`; the service
   * sets it. */
  stop: (target: TargetRef) => Promise<void> = async () => {
    throw new Error("Agents are closing");
  };

  /** Abort an agent's work and record the interrupt's watermark, whoever
   * asked for it, under the agent's turn that the caller holds; the
   * service sets it. Not bound to the caller's call, so the watermark
   * follows every abort, also when that call is cancelled meanwhile. */
  interrupt: (agentId: string) => Promise<void> = async () => {
    throw new Error("Agents are closing");
  };

  /** Take an idle turn without waiting behind work that may need the
   * caller to finish, such as result presentation during a refresh. */
  async tryTurn(
    agentId: string,
    work: () => Promise<void>,
    retry: () => void,
  ): Promise<boolean> {
    if (this.turns.has(agentId)) {
      // One wakeup per recipient, however many refreshes try meanwhile.
      this.retries.set(agentId, retry);
      return false;
    }
    await this.turn(agentId, work);
    return true;
  }

  /**
   * Run `work` once the recipient's earlier turns ended. Cancelling
   * `context` while it waits gives up the turn without running `work`, so
   * a caller whose own work is being aborted never holds up the abort;
   * later turns still wait for the earlier ones. `work` can `hold` the
   * turn for work it stops waiting for, which then ends the turn.
   */
  async turn<T>(
    agentId: string,
    work: (hold: (pending: Promise<unknown>) => void) => Promise<T>,
    context?: Context,
  ): Promise<T> {
    // Stored turns never reject.
    const previous = this.turns.get(agentId) ?? Promise.resolve();
    const held: Promise<unknown>[] = [];
    const ready = context ? awaitWithContext(previous, context) : previous;
    const run = ready.then(() => work((pending) => held.push(pending)));
    // A turn ends once its work, what it held, and the turns before it
    // ended, also when its caller gave up waiting.
    const ended = Promise.allSettled([previous, run]).then(() =>
      Promise.allSettled(held),
    );
    const settled = ended.then(() => {});
    this.turns.set(agentId, settled);
    try {
      return await run;
    } finally {
      void ended.then(() => {
        if (this.turns.get(agentId) !== settled) return;
        this.turns.delete(agentId);
        const retry = this.retries.get(agentId);
        this.retries.delete(agentId);
        retry?.();
      });
    }
  }
}
