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
 *   │ Job                                              │
 *   │ Review src/run for error handling                │
 *   ╰─ ↑↓ move · ⏎ attach · s stop · esc ──────────────╯
 */

import {
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  matchesKey,
  parseKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Colorize } from "./format.js";
import {
  type Bold,
  boxLine,
  clamp,
  type DetailLine,
  edgeLine,
  fitHints,
  paneLayout,
  renderDetail,
  windowDetail,
} from "./frame.js";
import type { AgentPanel } from "./panel.js";

const REFRESH_MS = 500;
/** `close` dismisses the overlay, `select` moves the selection, and
 * anything else keeps it open as it is. */
type OverlayAction = "close" | { select: string } | undefined;

/** What the overlay shows and does; items are re-read every render. */
export interface OverlaySpec<T> {
  title: string;
  /** Shown when items() is empty. */
  emptyText: string;
  /** Key hints embedded in the bottom border, read on every render. */
  /** Key hints, which drop common ones when they don't fit. */
  footer: () => string[];
  /** The item to select first, by key. */
  initialKey?: string;
  items: () => T[];
  /** Stable identity, so the selection survives reordering. */
  keyOf: (item: T) => string;
  /** One table line; the renderer adds the selection marker. */
  row: (item: T, color: Colorize, bold: Bold) => string;
  /** Metadata line embedded in the separator; without it, a plain
   * separator, for details the selected row already describes. */
  headerLine?: (item: T, color: Colorize) => string;
  /** Detail pane lines, wrapped to the pane width. */
  detail: (item: T, color: Colorize, bold: Bold) => DetailLine[];
  /** Handle tab or shift+tab, also without items, which go to other
   * views. */
  onNavigate: (key: "tab" | "shift+tab", item: T | undefined) => OverlayAction;
  /** Handle enter, space, or a single-letter key on the selected item. */
  onAction: (key: string, item: T) => OverlayAction;
  /** Whether to re-render every 500 ms. */
  live?: () => boolean;
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
    private readonly bold: Bold,
    private readonly spec: OverlaySpec<T>,
    private readonly done: () => void,
  ) {
    this.selectedKey = spec.initialKey;
  }

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

  /** The bottom border's hints, fit inside it. */
  private footer(width: number, scroll = false): string {
    const hints = [...(scroll ? ["⇧↑↓ scroll"] : []), ...this.spec.footer()];
    return fitHints(hints, Math.max(1, width - 6));
  }

  render(width: number): string[] {
    const { color, spec } = this;
    const items = spec.items();
    this.syncTimer();
    if (items.length === 0)
      return [
        edgeLine(["╭", "╮"], color("accent", spec.title), width, color),
        boxLine(color("dim", spec.emptyText), width, color),
        edgeLine(["╰", "╯"], color("dim", this.footer(width)), width, color),
        "",
      ];
    const index = this.index(items);
    this.select(items, index);
    const item = items[index] as T;
    const { tableRows, detailRows } = paneLayout(
      this.tui.terminal.rows,
      items.length,
    );

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
        boxLine(
          `${marker}${spec.row(items[i] as T, color, this.bold)}`,
          width,
          color,
        ),
      );
    }
    lines.push(
      edgeLine(["├", "┤"], spec.headerLine?.(item, color) ?? "", width, color),
    );

    const anchor = spec.keyOf(item);
    if (anchor !== this.detailAnchor) {
      this.detailAnchor = anchor;
      this.detailOffset = 0;
    }
    const inner = Math.max(1, width - 4);
    const detail = renderDetail(
      spec.detail(item, color, this.bold),
      inner,
      color,
      getMarkdownTheme(),
    );
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
    for (const line of shown)
      lines.push(
        "divider" in line
          ? edgeLine(["├", "┤"], line.divider, width, color)
          : boxLine(line.text, width, color),
      );
    for (let i = shown.length; i < this.detailFloor; i++)
      lines.push(boxLine("", width, color));

    const hints = this.footer(width, maxOffset > 0);
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
    const key = parseKey(data) ?? data;
    if (key === "tab" || key === "shift+tab") {
      const item = items.length > 0 ? items[this.index(items)] : undefined;
      this.apply(this.spec.onNavigate(key, item));
      return;
    }
    if (items.length === 0) return;
    const index = this.index(items);
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
    else if (key === "space") this.act(key, items[index] as T);
    else if (/^[a-z]$/.test(key)) this.act(key, items[index] as T);
    this.tui.requestRender();
  }

  private act(key: string, item: T): void {
    this.apply(this.spec.onAction(key, item));
  }

  private apply(action: OverlayAction): void {
    if (action === "close") this.close();
    else if (action) this.selectedKey = action.select;
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
      return new SplitPaneOverlay(
        tui,
        color,
        (text) => theme.bold(text),
        spec,
        () => done(undefined),
      );
    });
  } finally {
    panel?.setSuppressed(false);
  }
}
