/**
 * Threads: everything two agents sent each other, in order. Messages are
 * one-way, so a thread is the pair's whole exchange in both directions.
 */

import type { MessageInfo } from "../agents/types.js";

export interface Thread {
  /** Stable identity: the two agent IDs, ordered. */
  key: string;
  /** The two agents, in the order of the thread's first message. */
  agents: [MessageInfo["from"], MessageInfo["to"]];
  /** Oldest first. */
  messages: MessageInfo[];
}

/** The thread a message belongs to. */
export function threadKey(message: Pick<MessageInfo, "from" | "to">): string {
  const [low, high] = [message.from.id, message.to.id].sort(
    (left, right) => Number(left) - Number(right),
  );
  return `thread:${low}:${high}`;
}

/** Threads of the messages, latest activity first; with `agentId`, only
 * that agent's. */
export function buildThreads(
  messages: readonly MessageInfo[],
  agentId?: string,
): Thread[] {
  const threads = new Map<string, Thread>();
  for (const message of messages) {
    if (
      agentId !== undefined &&
      message.from.id !== agentId &&
      message.to.id !== agentId
    )
      continue;
    const key = threadKey(message);
    const thread = threads.get(key);
    if (thread) thread.messages.push(message);
    else
      threads.set(key, {
        key,
        agents: [message.from, message.to],
        messages: [message],
      });
  }
  const latest = (thread: Thread) => thread.messages.at(-1)?.sentAt ?? 0;
  return [...threads.values()].sort(
    (left, right) => latest(right) - latest(left),
  );
}

/** `scout ⇄ notes`, or `notes ⇄ scout` seen from `notes`. */
export function threadPair(thread: Thread, from?: string): string {
  const [first, second] = thread.agents;
  return second.id === from
    ? `${second.name} ⇄ ${first.name}`
    : `${first.name} ⇄ ${second.name}`;
}

/** The agent of a thread other than `agentId`. */
export function peerOf(thread: Thread, agentId: string): MessageInfo["from"] {
  const [first, second] = thread.agents;
  return first.id === agentId ? second : first;
}
