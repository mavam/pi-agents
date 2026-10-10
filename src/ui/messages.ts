/**
 * Message lines, shared by the panel, the transcript, and the attach view:
 *
 *   □ scout → notes    bun.lock is 412 KB                    ✔
 *
 * The kind glyph, then sender and recipient in bold in a fixed-width column,
 * so text always starts in the same column, then the first line of the
 * text, then the status at the right edge. Text truncates first, names
 * last.
 *
 * The transcript and the attach view show messages as cards, like Pi's
 * custom messages, with the whole text below the line when it doesn't fit.
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

/** The kind glyph of a one-way message. */
export const MESSAGE_ICON = "□";

/** Where a message is: queued, delivered, or dropped. */
export const MESSAGE_STATUS_STYLES = {
  queued: { icon: "◷", color: "dim" },
  delivered: { icon: "✔", color: "success" },
  dropped: { icon: "✘", color: "error" },
} as const satisfies Record<
  MessageStatus,
  { icon: string; color: Parameters<Colorize>[0] }
>;

/** The widest sender and recipient column. */
const MAX_PAIR_WIDTH = 28;

export type MessageLineParts = Pick<MessageInfo, "text"> & {
  from: string;
  to: string;
  status?: MessageStatus;
};

/** `scout → notes`. */
export function messagePair(message: { from: string; to: string }): string {
  return `${message.from} → ${message.to}`;
}

/** The width of the sender and recipient column for these messages. */
export function pairWidth(
  messages: ReadonlyArray<{ from: string; to: string }>,
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

function padTo(text: string, width: number): string {
  const fitted = truncateToWidth(text, width, "…");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
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

/** `scout → notes` padded to `column`, the names in bold. */
function formatPair(
  message: { from: string; to: string },
  column: number,
  { color, bold }: MessageStyle,
): string {
  const pair = messagePair(message);
  const width = visibleWidth(pair);
  if (width > column) return bold(truncateToWidth(pair, column, "…"));
  return `${bold(message.from)}${color("dim", " → ")}${bold(message.to)}${" ".repeat(column - width)}`;
}

/** A message row, exactly `width` wide unless `width` is too small. */
export function formatMessageLine(
  message: MessageLineParts,
  width: number,
  style: MessageStyle = plainStyle,
  column = pairWidth([message]),
): string {
  const { color } = style;
  const head = `${color("dim", MESSAGE_ICON)} ${formatPair(message, column, style)}`;
  const status = message.status
    ? MESSAGE_STATUS_STYLES[message.status]
    : undefined;
  const tail = status ? ` ${color(status.color, status.icon)}` : "";
  const room = width - visibleWidth(head) - visibleWidth(tail) - 2;
  if (room < 4)
    return truncateToWidth(`${head}${tail}`, Math.max(1, width), "…");
  const text = padTo(firstLine(message.text), room);
  return `${head}  ${color("dim", text)}${tail}`;
}

/** The narrowest sender and recipient column of a card, so most cards
 * align; longer names widen it rather than get cut. */
const CARD_PAIR_WIDTH = 20;

/** A message's line and, when `full` and the line cuts it, its whole text. */
class MessageLines implements Component {
  constructor(
    private readonly message: MessageLineParts,
    private readonly full: boolean,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    // Content is a pure function of the message.
  }

  render(width: number): string[] {
    const style = themeStyle(this.theme);
    const { color } = style;
    const usable = Math.max(8, width);
    const column = Math.max(
      CARD_PAIR_WIDTH,
      visibleWidth(messagePair(this.message)),
    );
    const line = formatMessageLine(
      this.message,
      usable,
      style,
      column,
    ).trimEnd();
    const text = this.message.text.trim();
    const whole = !text.includes("\n") && line.includes(sanitizeLine(text));
    if (!this.full || whole) return [line];
    const body = text
      .split("\n")
      .flatMap((paragraph) =>
        wrapTextWithAnsi(sanitizeLine(paragraph), Math.max(4, usable - 2)),
      )
      .map((part) => `  ${color("dim", part)}`);
    return [line, ...body];
  }
}

/** A message as a card on Pi's custom message background. */
export function messageCard(
  message: MessageLineParts,
  full: boolean,
  theme: Theme,
): Component {
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  card.addChild(new MessageLines(message, full, theme));
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
