/**
 * How messages between agents look, in one place: a line, and a card built
 * on it.
 *
 *   scout → notes bun.lock is 412 KB 3s                  a line
 *   scout → notes bun.lock is 412 KB                     a card
 *
 * A line is who, sender and recipient in bold, then the first line of the
 * text, with `…` when more follow, whose color is its status (normal once
 * delivered, dim while queued, red once dropped), then, for live views,
 * how long it waited. The panel shows lines.
 *
 * A card is a message in a conversation: the line on Pi's message
 * background. Collapsed, it's one line; expanded (Ctrl+O), a text the line
 * cuts shows in full below who. Pi's transcript and the attach view show
 * cards, for received and sent messages alike: the names say who sent
 * what. Every line fits its width.
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
import { type Colorize, plainColorize, sanitizeLine } from "./format.js";

/** A message text's color by status: normal once delivered, dim while
 * queued, red once dropped. */
const MESSAGE_STATUS_COLORS = {
  queued: "dim",
  delivered: "text",
  dropped: "error",
} as const satisfies Record<MessageStatus, Parameters<Colorize>[0]>;

/** Color a message's text by its status; a message without one is plain
 * history. */
function statusColor(
  text: string,
  status: MessageStatus | undefined,
  color: Colorize,
): string {
  return status ? color(MESSAGE_STATUS_COLORS[status], text) : text;
}

/** What a line or card shows of a message. */
export type MessageParts = Pick<MessageInfo, "text"> & {
  from: string;
  to: string;
  status?: MessageStatus;
  /** How long it has waited, for live views, such as `3s`. */
  age?: string;
};

/** `scout → notes`. */
export function messagePair(message: { from: string; to: string }): string {
  return `${message.from} → ${message.to}`;
}

/** The first line of a message, flattened for one row, with `…` when
 * more lines follow, so it doesn't read as the whole message. */
export function firstLine(text: string): string {
  const [first = "", ...rest] = text.trim().split("\n");
  const more = rest.some((line) => line.trim() !== "");
  return `${sanitizeLine(first).trimEnd()}${more ? " …" : ""}`;
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

/** `scout → notes`, the names in bold and the arrow dim. */
function formatPair(
  message: { from: string; to: string },
  { color, bold }: MessageStyle,
): string {
  return `${bold(message.from)}${color("dim", " → ")}${bold(message.to)}`;
}

/**
 * A message's line, at most `width` wide: who, then the text colored by its
 * status, then its age. Lines don't align in columns, so the text gets the
 * room; only the line's end is cut, never a name.
 */
export function messageLine(
  message: MessageParts,
  width: number,
  style: MessageStyle = plainStyle,
): string {
  const { color } = style;
  const head = formatPair(message, style);
  const tail = message.age ? color("dim", ` ${message.age}`) : "";
  const room = width - visibleWidth(head) - visibleWidth(tail) - 1;
  // Too narrow for text: the names, with the age if it fits; past the
  // row's end, the row is cut.
  if (room < 4) {
    const fits = visibleWidth(head) + visibleWidth(tail) <= width;
    return truncateToWidth(fits ? `${head}${tail}` : head, width, "…");
  }
  const text = truncateToWidth(firstLine(message.text), room, "…");
  return `${head} ${statusColor(text, message.status, color)}${tail}`;
}

/** A card's lines: the message's line; expanded, when the line cuts the
 * text, who, then the whole text below. `/messages` has the times. */
class MessageLines implements Component {
  constructor(
    private readonly message: MessageParts,
    private readonly expanded: () => boolean,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    // Content is a pure function of the message.
  }

  render(width: number): string[] {
    const style = themeStyle(this.theme);
    const { color } = style;
    const line = messageLine(this.message, width, style);
    const text = this.message.text.trim();
    const whole =
      !text.includes("\n") &&
      visibleWidth(messagePair(this.message)) + visibleWidth(text) + 1 <= width;
    if (!this.expanded() || whole) return [line];
    const who = formatPair(this.message, style);
    const body = text
      .split("\n")
      .flatMap((paragraph) =>
        wrapTextWithAnsi(sanitizeLine(paragraph), Math.max(4, width - 2)),
      )
      .map((part) => `  ${statusColor(part, this.message.status, color)}`);
    // Every line fits, so long names are cut at the row's end.
    return [truncateToWidth(who, width, "…"), ...body];
  }
}

/**
 * A message as a card on Pi's custom message background. `expanded` says
 * whether it shows the whole text; a function, so a view can toggle it.
 */
export function messageCard(
  message: MessageParts,
  expanded: boolean | (() => boolean),
  theme: Theme,
): Component {
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  card.addChild(
    new MessageLines(
      message,
      typeof expanded === "function" ? expanded : () => expanded,
      theme,
    ),
  );
  return card;
}

/** A message's parts for its line or card. */
export function messageParts(message: MessageInfo): MessageParts {
  return {
    from: message.from.name,
    to: message.to.name,
    text: message.text,
    status: message.status,
  };
}
