/**
 * `/messages`: every message between agents in one stream, newest first,
 * one line each in the format of message cards, with the time in front:
 *
 *   ╭─ Messages (22) · alpha ──────────────────────────────────────╮
 *   │   12:48:31 beta → alpha Location proposal: reserve the centr… │
 *   │ ▸ 12:48:30 alpha → gamma Offer two inclusive picnic activiti… │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ Offer two inclusive picnic activities: a relaxed             │
 *   │ nature-scavenger hunt with seated options.                   │
 *   ╰─ ↑↓ move · ⏎ close · ← alpha · → gamma · esc close ──────────╯
 *
 * The text starts right after the names, so rows are ragged but the text
 * gets the room. Names stand out, the text is dim, and red once dropped.
 * Typing filters by text and names; Space types too. ⏎ opens
 * the selected message as Markdown in a pane below the list, which follows
 * the selection, and closes it again. ← attaches to the sender and → to the
 * recipient, in the order the line names them. Tab and Shift+Tab go on to
 * the other views. Esc closes the pane, then clears the filter, then
 * closes.
 */

import {
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  isKeyRelease,
  parseKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MessageInfo } from "../agents/types.js";
import {
  boxLine,
  edgeLine,
  fitHints,
  paneLayout,
  renderDetail,
  windowDetail,
} from "./frame.js";
import {
  firstLine,
  formatClock,
  type MessageStyle,
  messagePair,
  themeStyle,
} from "./messages.js";
import type { AgentPanel } from "./panel.js";

const REFRESH_MS = 500;

/** Whether a message matches a filter: its text, sender, or recipient
 * contains it, ignoring case. */
function matches(message: MessageInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    message.text,
    message.from.name,
    message.to.name,
    messagePair({ from: message.from.name, to: message.to.name }),
  ].some((field) => field.toLowerCase().includes(needle));
}

/** The stream: messages that match the filter, newest first. */
export function messageStream(
  messages: readonly MessageInfo[],
  query = "",
): MessageInfo[] {
  return messages.filter((message) => matches(message, query)).reverse();
}

/** A message's row: its time, who, and the first line of its text, cut at
 * `width`. The names stand out; the text is dim, red once dropped. */
export function streamRow(
  message: MessageInfo,
  width: number,
  style: MessageStyle,
): string {
  const { color, bold } = style;
  const lead = `${color("dim", formatClock(message.sentAt))} ${bold(message.from.name)}${color("dim", " → ")}${bold(message.to.name)} `;
  const line = firstLine(message.text.trim());
  const text = color(message.status === "dropped" ? "error" : "dim", line);
  return truncateToWidth(`${lead}${text}`, width, "…");
}

export interface StreamOptions {
  /** All messages, oldest first. */
  messages: () => MessageInfo[];
  /** The filter to start with, such as an agent's name. */
  query?: string;
  /** The message to select first, by ID. */
  select?: string;
  emptyText: string;
  /** Attach to an agent; closes the stream first. */
  attach: (agentId: string) => void;
  /** Where Tab and Shift+Tab go; closes the stream first. */
  next: { label: string; open: () => void };
  previous: { label: string; open: () => void };
  /** Whether to re-render every 500 ms. */
  live: () => boolean;
}

class MessageStreamView implements Component {
  private query: string;
  private selected: string | undefined;
  /** Whether the pane with the selected message's text is open. */
  private reading = false;
  private detailOffset = 0;
  private detailAnchor: string | undefined;
  private detailMax = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly style: MessageStyle,
    private readonly options: StreamOptions,
    private readonly done: (after?: () => void) => void,
  ) {
    this.query = options.query ?? "";
    this.selected = options.select;
  }

  private items(): MessageInfo[] {
    return messageStream(this.options.messages(), this.query);
  }

  private index(items: MessageInfo[]): number {
    const index = items.findIndex((message) => message.id === this.selected);
    return index >= 0 ? index : 0;
  }

  private syncTimer(): void {
    const live = this.options.live();
    if (live && !this.timer) {
      this.timer = setInterval(() => this.tui.requestRender(), REFRESH_MS);
      this.timer.unref?.();
    } else if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  render(width: number): string[] {
    this.syncTimer();
    const { color } = this.style;
    const items = this.items();
    const filter = this.query ? ` · ${this.query}▌` : "";
    const title = color("accent", `Messages (${items.length})${filter}`);
    const lines = [edgeLine(["╭", "╮"], title, width, color)];
    const inner = Math.max(8, width - 4);
    const index = this.index(items);
    const selected = items[index];
    if (selected) this.selected = selected.id;
    const reading = this.reading && selected !== undefined;
    const hints = [
      "type to filter",
      "↑↓ move",
      `⏎ ${reading ? "close" : "read"}`,
      ...(selected ? [`← ${selected.from.name}`, `→ ${selected.to.name}`] : []),
      `tab ${this.options.next.label}`,
      reading ? "esc close" : this.query ? "esc clear" : "esc back",
    ];
    const footer = (scroll: boolean) =>
      edgeLine(
        ["╰", "╯"],
        color(
          "dim",
          fitHints([...(scroll ? ["⇧↑↓ scroll"] : []), ...hints], width - 6),
        ),
        width,
        color,
      );
    if (!selected) {
      const empty = this.query
        ? `Nothing matches ${this.query}.`
        : this.options.emptyText;
      lines.push(boxLine(color("dim", empty), width, color));
      lines.push(footer(false), "");
      return lines;
    }
    // Like the other overlays: under about 80% of the terminal. Reading,
    // the list gets the top and the pane the rest, both fixed, so nothing
    // moves while the selection changes.
    const layout = paneLayout(this.tui.terminal.rows, items.length);
    const listRows = reading
      ? layout.tableRows
      : Math.min(items.length, layout.tableRows + layout.detailRows + 1);
    const start = Math.max(
      0,
      Math.min(index - Math.floor(listRows / 2), items.length - listRows),
    );
    items.slice(start, start + listRows).forEach((message, offset) => {
      const marker = start + offset === index ? color("accent", "▸ ") : "  ";
      lines.push(
        boxLine(
          `${marker}${streamRow(message, inner - 2, this.style)}`,
          width,
          color,
        ),
      );
    });
    let scroll = false;
    if (reading) {
      lines.push(edgeLine(["├", "┤"], "", width, color));
      if (selected.id !== this.detailAnchor) {
        this.detailAnchor = selected.id;
        this.detailOffset = 0;
      }
      const detail = renderDetail(
        [{ markdown: selected.text.trim() }],
        inner,
        color,
        getMarkdownTheme(),
      );
      const { shown, offset, maxOffset } = windowDetail(
        detail,
        layout.detailRows,
        this.detailOffset,
        color,
      );
      this.detailOffset = offset;
      this.detailMax = maxOffset;
      scroll = maxOffset > 0;
      for (const line of shown)
        lines.push(boxLine("text" in line ? line.text : "", width, color));
      for (let i = shown.length; i < layout.detailRows; i++)
        lines.push(boxLine("", width, color));
    }
    lines.push(footer(scroll), "");
    return lines;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const keybindings = getKeybindings();
    const key = parseKey(data) ?? data;
    const items = this.items();
    const index = this.index(items);
    const select = (next: number) => {
      const item = items[Math.max(0, Math.min(items.length - 1, next))];
      this.selected = item?.id;
    };
    const scroll = (delta: number) => {
      this.detailOffset = Math.max(
        0,
        Math.min(this.detailMax, this.detailOffset + delta),
      );
    };
    if (keybindings.matches(data, "tui.select.cancel")) {
      if (this.reading) this.reading = false;
      else if (this.query) this.query = "";
      else {
        this.close();
        return;
      }
    } else if (key === "shift+up") scroll(-1);
    else if (key === "shift+down") scroll(1);
    else if (key === "shift+pageUp") scroll(-10);
    else if (key === "shift+pageDown") scroll(10);
    else if (keybindings.matches(data, "tui.select.up") || key === "up")
      select(index - 1);
    else if (keybindings.matches(data, "tui.select.down") || key === "down")
      select(index + 1);
    else if (key === "pageUp") select(index - 10);
    else if (key === "pageDown") select(index + 10);
    else if (keybindings.matches(data, "tui.select.confirm"))
      this.reading = !this.reading && items.length > 0;
    else if (key === "left" || key === "right") {
      const message = items[index];
      const agent = key === "left" ? message?.from.id : message?.to.id;
      if (agent) {
        this.close(() => this.options.attach(agent));
        return;
      }
    } else if (key === "tab" || key === "shift+tab") {
      const target = key === "tab" ? this.options.next : this.options.previous;
      this.close(target.open);
      return;
    } else if (key === "backspace") this.query = this.query.slice(0, -1);
    else if (key === "space" || (!data.startsWith("\u001b") && data >= " ")) {
      // Space types too, so a filter can have several words.
      this.query += key === "space" ? " " : data;
      this.selected = undefined;
    }
    this.tui.requestRender();
  }

  private close(after?: () => void): void {
    this.dispose();
    this.done(after);
  }

  invalidate(): void {
    // Every render re-reads the messages.
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Open the stream in the editor slot, hiding the agent panel meanwhile. */
export async function openMessageStream(
  ctx: Pick<ExtensionContext, "ui">,
  options: StreamOptions,
  panel?: Pick<AgentPanel, "setSuppressed">,
): Promise<void> {
  let after: (() => void) | undefined;
  panel?.setSuppressed(true);
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const style = themeStyle(theme);
      return new MessageStreamView(tui, style, options, (then) => {
        after = then;
        done(undefined);
      });
    });
  } finally {
    panel?.setSuppressed(false);
  }
  after?.();
}
