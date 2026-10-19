/**
 * Where an agent's input comes from. The model reads the origin from a
 * marker in the text, such as `[user] ` or `[from <name>] `; the transcript
 * stores it explicitly, as the input entry's kind and data, so views never
 * have to guess it from the text. A plain `pi.user` input is the parent's.
 */

import { RESULTS_ENTRY, RESULTS_PREFIX } from "./obligations.js";
import { messageInput, USER_MESSAGE_PREFIX } from "./types.js";

/** Pi-durable's kind of a plain input: the parent's requests and jobs. */
export const PLAIN_INPUT_KIND = "pi.user";
/** A message the user typed in the attach view. */
export const USER_INPUT_KIND = "pi-agents.user";
/** A message from another agent; its data names the sender. */
export const MESSAGE_INPUT_KIND = "pi-agents.message";

/** Kinds of entries that hold an agent's input. */
export const INPUT_KINDS: ReadonlySet<string> = new Set([
  PLAIN_INPUT_KIND,
  USER_INPUT_KIND,
  MESSAGE_INPUT_KIND,
  RESULTS_ENTRY,
]);

/** An input entry's kind and data, as a submission or inbox item carries
 * them. */
export interface InputEntry {
  kind: string;
  data?: unknown;
}

/** The text and entry of a message the user typed in the attach view. */
export function userInput(text: string): {
  content: string;
  entry: { kind: string; data: { [key: string]: never } };
} {
  return {
    content: `${USER_MESSAGE_PREFIX}${text}`,
    entry: { kind: USER_INPUT_KIND, data: {} },
  };
}

/** The text and entry of a message from the agent named `from`. */
export function agentMessageInput(
  from: string,
  text: string,
): { content: string; entry: { kind: string; data: { from: string } } } {
  return {
    content: messageInput(from, text),
    entry: { kind: MESSAGE_INPUT_KIND, data: { from } },
  };
}

/** Who sent an input, and its text without the marker. */
export type InputOrigin =
  | { kind: "parent"; text: string }
  | { kind: "user"; text: string }
  | { kind: "message"; from: string; text: string }
  /** The results of groups the agent spawned. */
  | { kind: "results"; text: string };

function strip(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** The origin of an input with this entry and text, as its entry names
 * it. */
export function inputOrigin(
  entry: InputEntry | undefined,
  content: string,
): InputOrigin {
  if (entry?.kind === USER_INPUT_KIND)
    return { kind: "user", text: strip(content, USER_MESSAGE_PREFIX) };
  if (entry?.kind === MESSAGE_INPUT_KIND) {
    const from = (entry.data as { from?: unknown } | undefined)?.from;
    if (typeof from === "string")
      return {
        kind: "message",
        from,
        text: strip(content, messageInput(from, "")),
      };
  }
  if (entry?.kind === RESULTS_ENTRY)
    return { kind: "results", text: strip(content, RESULTS_PREFIX) };
  return { kind: "parent", text: content };
}
