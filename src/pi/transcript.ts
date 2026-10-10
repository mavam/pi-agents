/**
 * Messages between agents in Pi's transcript: one custom entry per message,
 * which only the user sees; Pi's model doesn't. Entries only append, and a
 * message the session already shows, on any branch, isn't appended again,
 * also after a restart.
 *
 *   □ scout → notes        bun.lock is 412 KB
 *
 * Expanded (Ctrl+O), an entry shows the message's whole text.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MessageInfo } from "../agents/types.js";
import { messageCard } from "../ui/messages.js";

export const MESSAGE_ENTRY = "pi-agents:message";

export interface MessageEntryData {
  version: 1;
  /** The message's ID and when it was sent, unique across stores. */
  key: string;
  from: string;
  to: string;
  text: string;
}

function isMessageEntryData(value: unknown): value is MessageEntryData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.key === "string" &&
    typeof data.from === "string" &&
    typeof data.to === "string" &&
    typeof data.text === "string"
  );
}

/** A message's identity in the session: a Pi session forked from another
 * copies its entries, while its agents start over in a new store. */
function entryKey(message: MessageInfo): string {
  return `${message.id}@${message.sentAt}`;
}

export function registerMessageEntryRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(MESSAGE_ENTRY, (entry, options, theme) => {
    if (!isMessageEntryData(entry.data)) return undefined;
    return messageCard(entry.data, options.expanded, theme);
  });
}

/** Appends a transcript entry for every message the session doesn't show
 * yet. */
export class MessageTranscript {
  private readonly shown = new Set<string>();
  private active = false;

  constructor(private readonly pi: ExtensionAPI) {}

  /** Session start: remember the messages the session already shows. */
  start(ctx: ExtensionContext): void {
    this.shown.clear();
    for (const entry of ctx.sessionManager.getEntries())
      if (
        entry.type === "custom" &&
        entry.customType === MESSAGE_ENTRY &&
        isMessageEntryData(entry.data)
      )
        this.shown.add(entry.data.key);
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  sync(messages: readonly MessageInfo[]): void {
    if (!this.active) return;
    for (const message of messages) {
      const key = entryKey(message);
      if (this.shown.has(key)) continue;
      this.shown.add(key);
      const data: MessageEntryData = {
        version: 1,
        key,
        from: message.from.name,
        to: message.to.name,
        text: message.text,
      };
      this.pi.appendEntry(MESSAGE_ENTRY, data);
    }
  }
}
