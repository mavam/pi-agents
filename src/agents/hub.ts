/**
 * What the messaging tools share with the service in one process, which
 * owns the store: a turn order per recipient, so a send and a stop of the
 * same agent never interleave, and the service's view of agents' states.
 */

import type { AgentState } from "./types.js";

export class MessagingHub {
  private readonly turns = new Map<string, Promise<unknown>>();

  /** An agent's state as the service derives it; the service sets it. */
  state: (agentId: string) => AgentState | undefined = () => undefined;

  /** Run `work` once the recipient's earlier turns ended. */
  async turn<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const settled = run.catch(() => {});
    this.turns.set(agentId, settled);
    try {
      return await run;
    } finally {
      if (this.turns.get(agentId) === settled) this.turns.delete(agentId);
    }
  }
}
