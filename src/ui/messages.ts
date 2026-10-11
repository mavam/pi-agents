/**
 * Message lines and cards, shared by the panel, the transcript, the attach
 * view, and `/messages`:
 *
 *   scout → notes bun.lock is 412 KB 3s
 *
 * Who: the pair in bold, or, seen from one agent, an arrow and the other
 * agent (`← scout` received, `→ notes` sent), then the first line of the
 * text, and for live views how long it waited. The text's color is its
 * status: normal once delivered, dim while queued, red once dropped.
 *
 * Cards, in the transcript and the attach view, stand alone, so they name
 * who and when on their own line and show the text below it; a short text
 * that fits joins the line.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MessageInfo, MessageStatus } from "../agents/types.js";
import {
  AGENT_ICON,
  type Colorize,
  plainColorize,
  sanitizeLine,
} from "./format.js";

/** A message text's color by status: normal once delivered, dim while
 * queued, red once dropped. */
export const MESSAGE_STATUS_COLORS = {
  queued: "dim",
  delivered: "text",
  dropped: "error",
} as const satisfies Record<MessageStatus, Parameters<Colorize>[0]>;

/** Color a message's text by its status; a message without one, such as
 * a card in the transcript, is plain history. */
export function statusColor(
  text: string,
  status: MessageStatus | undefined,
  color: Colorize,
): string {
  return status ? color(MESSAGE_STATUS_COLORS[status], text) : text;
}

/** The widest sender and recipient column. */
const MAX_PAIR_WIDTH = 28;

export type MessageLineParts = Pick<MessageInfo, "text"> & {
  from: string;
  to: string;
  status?: MessageStatus;
  /** How long it has waited, for live views, such as `3s`. */
  age?: string;
  /** When it was sent, for cards. */
  sentAt?: number;
  /** The agent the line is seen from, which then shows only the other
   * agent and an arrow. */
  viewpoint?: string;
};

/** Who a message is between: `scout → notes`, or from one agent's view,
 * `← scout` (received) or `→ notes` (sent). */
export function messagePair(message: {
  from: string;
  to: string;
  viewpoint?: string;
}): string {
  if (message.viewpoint === message.to) return `← ${message.from}`;
  if (message.viewpoint === message.from) return `→ ${message.to}`;
  return `${message.from} → ${message.to}`;
}

/** The width of the sender and recipient column for these messages. */
export function pairWidth(
  messages: ReadonlyArray<{ from: string; to: string; viewpoint?: string }>,
): number {
  return Math.min(
    MAX_PAIR_WIDTH,
    Math.max(
      0,
      ...messages.map((message) => visibleWidth(messagePair(message))),
    ),
  );
}

/** The first line of a message, flattened for one row. */
export function firstLine(text: string): string {
  return sanitizeLine(text.trim().split("\n")[0] ?? "");
}

/** Colors and bold, from Pi's theme. */
export interface MessageStyle {
  color: Colorize;
  bold: (text: string) => string;
}

export const plainStyle: MessageStyle = {
  color: plainColorize,
  bold: (text) => text,
};

export function themeStyle(theme: Theme): MessageStyle {
  return {
    color: (name, text) => theme.fg(name, text),
    bold: (text) => theme.bold(text),
  };
}

/** `HH:MM:SS`, with the date before it unless it's today. */
export function formatClock(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** Who, padded to `column`, the names in bold and the arrow dim. */
function formatPair(
  message: { from: string; to: string; viewpoint?: string },
  column: number,
  { color, bold }: MessageStyle,
): string {
  const pair = messagePair(message);
  const width = visibleWidth(pair);
  if (width > column) return bold(truncateToWidth(pair, column, "…"));
  const pad = " ".repeat(column - width);
  if (message.viewpoint === message.to)
    return `${color("dim", "← ")}${bold(message.from)}${pad}`;
  if (message.viewpoint === message.from)
    return `${color("dim", "→ ")}${bold(message.to)}${pad}`;
  return `${bold(message.from)}${color("dim", " → ")}${bold(message.to)}${pad}`;
}

/** A message row, at most `width` wide: who, then the text colored by its
 * status, then its age right after it. */
export function formatMessageLine(
  message: MessageLineParts,
  width: number,
  style: MessageStyle = plainStyle,
  column = pairWidth([message]),
): string {
  const { color } = style;
  const head = formatPair(message, column, style);
  const tail = message.age ? color("dim", ` ${message.age}`) : "";
  const room = width - visibleWidth(head) - visibleWidth(tail) - 1;
  if (room < 4)
    return truncateToWidth(`${head}${tail}`, Math.max(1, width), "…");
  const text = truncateToWidth(firstLine(message.text), room, "…");
  return `${head} ${statusColor(text, message.status, color)}${tail}`;
}

/** A card's text: on its header line when it fits there and `full` doesn't
 * ask for more, else below it. */
class MessageLines implements Component {
  constructor(
    private readonly message: MessageLineParts,
    private readonly full: boolean,
    private readonly theme: Theme,
    private readonly marked: boolean,
  ) {}

  invalidate(): void {
    // Content is a pure function of the message.
  }

  render(width: number): string[] {
    const style = themeStyle(this.theme);
    const { color } = style;
    const usable = Math.max(8, width);
    const pair = visibleWidth(messagePair(this.message));
    const mark = this.marked ? `${color("accent", AGENT_ICON)} ` : "";
    const who = `${mark}${formatPair(this.message, pair, style)}`;
    const when =
      this.message.sentAt === undefined
        ? ""
        : color("dim", ` ${formatClock(this.message.sentAt)}`);
    const text = this.message.text.trim();
    const single = !text.includes("\n");
    const inline = `${who} ${sanitizeLine(text)}${when}`;
    if (!this.full && single && visibleWidth(inline) <= usable) return [inline];
    if (!this.full) {
      const room = usable - visibleWidth(who) - visibleWidth(when) - 1;
      const cut = truncateToWidth(firstLine(text), Math.max(4, room), "…");
      return [`${who} ${cut}${when}`];
    }
    const body = text
      .split("\n")
      .flatMap((paragraph) =>
        wrapTextWithAnsi(sanitizeLine(paragraph), Math.max(4, usable - 2)),
      )
      .map((part) => `  ${part}`);
    return [`${who}${when}`, ...body];
  }
}

/** A message as a card on Pi's custom message background. */
export function messageCard(
  message: MessageLineParts,
  full: boolean,
  theme: Theme,
  /** Start with `✦`, pi-agents' mark, where it shares a transcript with
   * other content, such as Pi's. */
  marked = false,
): Component {
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  card.addChild(new MessageLines(message, full, theme, marked));
  return card;
}

/** A message's parts for `formatMessageLine`. */
export function messageParts(message: MessageInfo): MessageLineParts {
  return {
    from: message.from.name,
    to: message.to.name,
    text: message.text,
    status: message.status,
  };
}
