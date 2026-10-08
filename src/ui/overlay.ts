/**
 * The split-pane overlay behind /agents: a keyboard-navigable table on top
 * and the selected item's details below, wrapped to the pane width.
 *
 * It replaces the composer in the editor slot (like Pi's /settings and
 * /model selectors) rather than floating over the transcript.
 *
 *   ╭─ Agents (1/2) ───────────────────────────────────╮
 *   │ ▸ ◉ reviewer  explorer  terra  15.5k             │
 *   │   ● docs      ad-hoc    sol    8.0k              │
 *   ├─ reviewer · /repo · started 4m ago ──────────────┤
 *   │ Task                                             │
 *   │ Review src/run for error handling                │
 *   ╰─ ↑↓ move · ⏎ attach · s stop · esc ──────────────╯
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  matchesKey,
  parseKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Colorize, plainColorize } from "./format.js";
import type { AgentPanel } from "./panel.js";

const MAX_TABLE_ROWS = 10;
const REFRESH_MS = 500;
/** Rows of the frame: title border, separator, footer border, blank row. */
const CHROME_ROWS = 4;

/** `close` dismisses the overlay; anything else keeps it open. */
type OverlayAction = "close" | undefined;

/** What the overlay shows and does; items are re-read every render. */
export interface OverlaySpec<T> {
  title: string;
  /** Shown when items() is empty. */
  emptyText: string;
  /** Key hints embedded in the bottom border. */
  footer: string;
  items: () => T[];
  /** Stable identity, so the selection survives reordering. */
  keyOf: (item: T) => string;
  /** One table line; the renderer adds the selection marker. */
  row: (item: T, color: Colorize) => string;
  /** Metadata line embedded in the separator. */
  headerLine: (item: T, color: Colorize) => string;
  /** Detail pane lines, wrapped to the pane width. */
  detail: (item: T, color: Colorize) => string[];
  /** Handle enter or a single-letter key. */
  onAction: (key: string, item: T) => OverlayAction;
  /** Whether to re-render every 500 ms. */
  live?: () => boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Window the detail lines into `rows`, marking hidden lines. Returns the
 * clamped offset and the largest offset for scrolling. */
function windowDetail(
  detail: string[],
  rows: number,
  offset = 0,
  color: Colorize = plainColorize,
): { shown: string[]; offset: number; maxOffset: number } {
  if (rows <= 0) return { shown: [], offset: 0, maxOffset: 0 };
  if (detail.length <= rows) return { shown: detail, offset: 0, maxOffset: 0 };
  const contentRows = rows > 1 ? rows - 1 : rows;
  const maxOffset = detail.length - contentRows;
  const start = clamp(offset, 0, maxOffset);
  const below = detail.length - start - contentRows;
  const content = detail.slice(start, start + contentRows);
  if (contentRows === rows) return { shown: content, offset: start, maxOffset };
  const marker = color(
    "dim",
    [
      start > 0 ? `… ${start} earlier lines` : undefined,
      below > 0 ? `… +${below} more lines` : undefined,
    ]
      .filter(Boolean)
      .join("  "),
  );
  return {
    shown: below === 0 ? [marker, ...content] : [...content, marker],
    offset: start,
    maxOffset,
  };
}

/** `│ content…pad │`, filled to the exact width. */
function boxLine(content: string, width: number, color: Colorize): string {
  const inner = Math.max(1, width - 4);
  const clipped = truncateToWidth(content, inner);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
  return `${color("dim", "│ ")}${clipped}${pad}${color("dim", " │")}`;
}

/** `╭─ label ────╮`: a border row with an embedded label. */
function edgeLine(
  corners: [string, string],
  label: string,
  width: number,
  color: Colorize,
): string {
  const text = label
    ? ` ${truncateToWidth(label, Math.max(1, width - 6))} `
    : "";
  const fill = Math.max(0, width - 3 - visibleWidth(text));
  return (
    color("dim", `${corners[0]}─`) +
    text +
    color("dim", `${"─".repeat(fill)}${corners[1]}`)
  );
}

class SplitPaneOverlay<T> implements Component {
  private selectedKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Highest detail row count shown, so the pane never shrinks. */
  private detailFloor = 0;
  private detailOffset = 0;
  private detailScroll = { maxOffset: 0, rows: 1 };
  private detailAnchor: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly color: Colorize,
    private readonly spec: OverlaySpec<T>,
    private readonly done: () => void,
  ) {}

  private index(items: T[]): number {
    const index = items.findIndex(
      (item) => this.spec.keyOf(item) === this.selectedKey,
    );
    return index >= 0 ? index : 0;
  }

  private select(items: T[], index: number): void {
    const item = items[clamp(index, 0, items.length - 1)];
    this.selectedKey = item === undefined ? undefined : this.spec.keyOf(item);
  }

  private syncTimer(): void {
    const live = this.spec.live?.() ?? false;
    if (live && !this.timer) {
      this.timer = setInterval(() => this.tui.requestRender(), REFRESH_MS);
      this.timer.unref?.();
    } else if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  render(width: number): string[] {
    const { color, spec } = this;
    const items = spec.items();
    this.syncTimer();
    if (items.length === 0)
      return [
        edgeLine(["╭", "╮"], color("accent", spec.title), width, color),
        boxLine(color("dim", spec.emptyText), width, color),
        edgeLine(["╰", "╯"], color("dim", spec.footer), width, color),
        "",
      ];
    const index = this.index(items);
    this.select(items, index);
    const item = items[index] as T;
    // Stay under about 80% of the terminal so some conversation stays
    // visible, with a floor that keeps the pane usable.
    const rows = this.tui.terminal.rows;
    const height = Math.max(8, Math.min(rows - 6, Math.floor(rows * 0.8)));
    const available = Math.max(2, height - CHROME_ROWS);
    const tableRows = Math.min(
      items.length,
      MAX_TABLE_ROWS,
      Math.max(1, Math.ceil(available / 2)),
    );
    const detailRows = Math.max(0, available - tableRows);

    const lines = [
      edgeLine(
        ["╭", "╮"],
        color("accent", `${spec.title} (${index + 1}/${items.length})`),
        width,
        color,
      ),
    ];
    const start = clamp(
      index - Math.floor(tableRows / 2),
      0,
      items.length - tableRows,
    );
    for (let i = start; i < start + tableRows; i++) {
      const marker = i === index ? color("accent", "▸ ") : "  ";
      lines.push(
        boxLine(`${marker}${spec.row(items[i] as T, color)}`, width, color),
      );
    }
    lines.push(
      edgeLine(["├", "┤"], spec.headerLine(item, color), width, color),
    );

    const anchor = spec.keyOf(item);
    if (anchor !== this.detailAnchor) {
      this.detailAnchor = anchor;
      this.detailOffset = 0;
    }
    const inner = Math.max(1, width - 4);
    const detail = spec
      .detail(item, color)
      .flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""]));
    const { shown, offset, maxOffset } = windowDetail(
      detail,
      detailRows,
      this.detailOffset,
      color,
    );
    this.detailOffset = offset;
    this.detailScroll = { maxOffset, rows: Math.max(1, detailRows) };
    this.detailFloor = clamp(
      Math.max(this.detailFloor, detail.length),
      0,
      detailRows,
    );
    for (const line of shown) lines.push(boxLine(line, width, color));
    for (let i = shown.length; i < this.detailFloor; i++)
      lines.push(boxLine("", width, color));

    const hints = maxOffset > 0 ? `⇧↑↓ scroll · ${spec.footer}` : spec.footer;
    lines.push(edgeLine(["╰", "╯"], color("dim", hints), width, color), "");
    return lines;
  }

  private scroll(delta: number): void {
    this.detailOffset = clamp(
      this.detailOffset + delta,
      0,
      this.detailScroll.maxOffset,
    );
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    const items = this.spec.items();
    if (items.length === 0) return;
    const index = this.index(items);
    const key = parseKey(data) ?? data;
    const page = Math.max(1, this.detailScroll.rows - 1);
    if (key === "shift+up" || matchesKey(data, "shift+k")) this.scroll(-1);
    else if (key === "shift+down" || matchesKey(data, "shift+j"))
      this.scroll(1);
    else if (key === "shift+pageUp") this.scroll(-page);
    else if (key === "shift+pageDown") this.scroll(page);
    else if (keybindings.matches(data, "tui.select.up") || data === "k")
      this.select(items, index - 1);
    else if (keybindings.matches(data, "tui.select.down") || data === "j")
      this.select(items, index + 1);
    else if (keybindings.matches(data, "tui.select.confirm"))
      this.act("enter", items[index] as T);
    else if (/^[a-z]$/.test(key)) this.act(key, items[index] as T);
    this.tui.requestRender();
  }

  private act(key: string, item: T): void {
    if (this.spec.onAction(key, item) === "close") this.close();
  }

  private close(): void {
    this.dispose();
    this.done();
  }

  invalidate(): void {
    // Stateless rendering: every render re-reads the spec's items.
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Open the overlay in the editor slot, hiding the agent panel meanwhile. */
export async function openOverlay<T>(
  ctx: Pick<ExtensionContext, "ui">,
  spec: OverlaySpec<T>,
  panel?: Pick<AgentPanel, "setSuppressed">,
): Promise<void> {
  panel?.setSuppressed(true);
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      return new SplitPaneOverlay(tui, color, spec, () => done(undefined));
    });
  } finally {
    panel?.setSuppressed(false);
  }
}
