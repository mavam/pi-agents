/**
 * Messages grouped by sender for `/messages`: one row per agent that sent
 * messages, its messages oldest first. Grouping by sender keeps the list as
 * long as the number of agents, however many pairs talk.
 */

import type { MessageInfo } from "../agents/types.js";

export interface SenderGroup {
  /** Stable identity: the sender's ID. */
  key: string;
  sender: MessageInfo["from"];
  /** Oldest first. */
  messages: MessageInfo[];
}

/** How `/messages` orders senders. */
export const SENDER_ORDERS = ["recent", "name", "count"] as const;
export type SenderOrder = (typeof SENDER_ORDERS)[number];

/** The group of a sender, by agent ID. */
export function senderKey(agentId: string): string {
  return `sender:${agentId}`;
}

/** Whether a message matches a search: its text, sender, or recipient
 * contains the query, ignoring case. */
export function matches(message: MessageInfo, query: string): boolean {
  const needle = query.toLowerCase();
  return [message.text, message.from.name, message.to.name].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/**
 * Senders of the messages, the most recent first unless `order` says
 * otherwise. With `agent`, only messages from or to that agent; with
 * `query`, only messages that match it.
 */
export function buildSenders(
  messages: readonly MessageInfo[],
  options: { agent?: string; query?: string; order?: SenderOrder } = {},
): SenderGroup[] {
  const { agent, query } = options;
  const groups = new Map<string, SenderGroup>();
  for (const message of messages) {
    if (
      agent !== undefined &&
      message.from.id !== agent &&
      message.to.id !== agent
    )
      continue;
    if (query && !matches(message, query)) continue;
    const key = senderKey(message.from.id);
    const group = groups.get(key);
    if (group) group.messages.push(message);
    else groups.set(key, { key, sender: message.from, messages: [message] });
  }
  const latest = (group: SenderGroup) => group.messages.at(-1)?.sentAt ?? 0;
  const order = options.order ?? "recent";
  return [...groups.values()].sort((left, right) =>
    order === "name"
      ? left.sender.name.localeCompare(right.sender.name)
      : order === "count"
        ? right.messages.length - left.messages.length ||
          latest(right) - latest(left)
        : latest(right) - latest(left),
  );
}
