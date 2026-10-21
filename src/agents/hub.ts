/**
 * What the messaging tools share with the service in one process, which
 * owns the store: a turn order per recipient, so a send and a stop of the
 * same agent never interleave, the service's view of agents' states, and
 * its stops.
 */

import type { AgentState, TargetRef } from "./types.js";

export class MessagingHub {
  private readonly turns = new Map<string, Promise<unknown>>();

  /** An agent's state as the service derives it; the service sets it. */
  state: (agentId: string) => AgentState | undefined = () => undefined;

  /** Stop an agent or a group for an agent's `agent_stop`; the service
   * sets it. */
  stop: (target: TargetRef) => Promise<void> = async () => {
    throw new Error("Agents are closing");
  };

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
