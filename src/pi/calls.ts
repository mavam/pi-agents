/**
 * Keys of the parent's tool calls. A call that spawns, sends, or stops
 * passes its key to the service, so repeating the call finds what its first
 * run did instead of acting again. The key is Pi's tool call ID qualified
 * by the session entry of the assistant message that issued the call: some
 * providers number calls per message, so IDs alone can repeat across
 * messages and would make a new call look like a repeated one.
 */

import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Whether the assistant message of `entry` issued `toolCallId`, directly
 * or as the caller of a nested call such as a codemode script's. */
function issued(entry: SessionEntry, toolCallId: string): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant")
    return false;
  return entry.message.content.some(
    (block) =>
      block.type === "toolCall" &&
      (block.id === toolCallId || toolCallId.startsWith(`${block.id}/`)),
  );
}

/** The key of the call `toolCallId`; none for calls without an ID. */
export function callKey(
  ctx: ExtensionContext,
  toolCallId: string,
): string | undefined {
  if (!toolCallId) return undefined;
  try {
    // Pi saves the issuing message before it runs the message's calls.
    const session = ctx.sessionManager;
    let entry = session.getLeafEntry();
    while (entry) {
      if (issued(entry, toolCallId)) return `${entry.id}/${toolCallId}`;
      entry = entry.parentId ? session.getEntry(entry.parentId) : undefined;
    }
  } catch {
    // No session to read; the ID alone keys the call.
  }
  return toolCallId;
}
