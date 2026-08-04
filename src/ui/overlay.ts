/**
 * Interactive split-pane panel for /workflows and /agents: a keyboard-
 * navigable table on top, the selected item's flow tree in a detail pane
 * below. One generic component; the commands supply an OverlaySpec.
 *
 * The panel replaces the composer in the editor slot (like pi's /settings and
 * /model selectors) rather than floating over the transcript, so it opens next
 * to where the user is looking.
 *
 *   ╭─ Runs · /triage (2/4) ─────────────────────────────╮
 *   │   ● 1a2b3c4d  completed  review    3t ↑12k  $0.08  │
 *   │ ▸ ● c9e5799a  completed  triage    5t ↑33k  $0.21  │
 *   ├─ c9e5799a · triage (command) · 1m32s · 33k tok ────┤
 *   │  ✦ scout → {files} · List files to review          │
 *   │  ⇶ map {files} (×4)                                │
 *   ╰─ ↑↓ move · ⏎ inspect · c cancel · r rerun · esc ───╯
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  Input,
  parseKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type Colorize, plainColorize, type RunWidget } from "./widget.js";

const MAX_TABLE_ROWS = 10;
const REFRESH_MS = 500;
/** Rows the frame itself owns: title border, table/detail separator, the
 * breathing room above the footer, and the footer border. */
const CHROME_ROWS = 4;

/** Border text; a function makes it dynamic (e.g. per drill-down mode). */
export type OverlayChrome = string | (() => string);

/** What an action asks the overlay to do: dismiss, move the selection
 * (e.g. after a mode switch changes the key namespace), or nothing. */
export interface OverlayComposer {
  label: string;
  submit: (value: string) => void | Promise<void>;
}

export type OverlayAction =
  | "close"
  | { selectKey: string }
  | { compose: OverlayComposer }
  | undefined;

/** What the overlay shows and does; items are re-read every render, so a
 * live model (runs completing, workflows hidden) refreshes for free. */
export interface OverlaySpec<T> {
  title: OverlayChrome;
  /** Shown when items() is empty. */
  emptyText: OverlayChrome;
  /** Key-hint line embedded in the bottom border. */
  footer: OverlayChrome;
  /** Optional item-sensitive footer (for actions available only when live). */
  footerFor?: (item: T) => string;
  items: () => T[];
  /** Stable identity, so selection survives list reorder/refresh. */
  keyOf: (item: T) => string;
  /** One table line (no selection marker; the renderer adds it). */
  row: (item: T, color: Colorize) => string;
  /** Metadata line embedded in the separator between table and detail. */
  headerLine: (item: T, color: Colorize) => string;
  /** Detail pane lines (typically the flow tree). */
  detail: (item: T, color: Colorize) => string[];
  /** Show the beginning by default; live tails opt into the newest lines. */
  detailWindow?: (item: T) => "head" | "tail";
  /** Handle enter or a single-letter shortcut. */
  onAction: (key: string, item: T) => OverlayAction;
  /** Intercept esc (e.g. to back out of a drill-down); default closes. */
  onCancel?: () => OverlayAction;
  /** When true, the overlay re-renders every 500ms. */
  live?: () => boolean;
}

function chrome(value: OverlayChrome): string {
  return typeof value === "function" ? value() : value;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Render pi-tui's single-line input without its built-in `> ` prompt. */
function renderInlineInput(input: Input, width: number): string {
  const line = input.render(width + 2)[0] ?? "";
  return line.startsWith("> ") ? line.slice(2) : line;
}

/** Window the detail lines into the pane, honouring a scroll offset.
 *
 * When the detail overflows, one row is spent on a marker that reports what is
 * hidden. The marker sits on the side content continues on, so the window
 * always touches the edge it is scrolled against: at the bottom while more
 * lines follow (including the unscrolled default), at the top once the last
 * line is visible — which keeps a followed live tail pinned to the bottom.
 * `offset` is the first detail line to show; "end" pins the window to the last
 * line. The resolved offset is returned so the caller can clamp its state. */
export function windowDetail(
  detail: string[],
  rows: number,
  offset: number | "end" = 0,
  color: Colorize = plainColorize,
): { shown: string[]; offset: number; maxOffset: number } {
  if (rows <= 0) return { shown: [], offset: 0, maxOffset: 0 };
  if (detail.length <= rows) return { shown: detail, offset: 0, maxOffset: 0 };
  const contentRows = Math.max(1, rows - 1);
  const maxOffset = detail.length - contentRows;
  const start = clamp(offset === "end" ? maxOffset : offset, 0, maxOffset);
  const hiddenAbove = start;
  const hiddenBelow = detail.length - start - contentRows;
  const marker = color(
    "dim",
    [
      hiddenAbove > 0 ? `… ${hiddenAbove} earlier lines` : undefined,
      hiddenBelow > 0 ? `… +${hiddenBelow} more lines` : undefined,
    ]
      .filter(Boolean)
      .join("  "),
  );
  const content = detail.slice(start, start + contentRows);
  return {
    shown: hiddenBelow === 0 ? [marker, ...content] : [...content, marker],
    offset: start,
    maxOffset,
  };
}

/** Split the height budget between the table and the detail pane. */
function paneRows(
  itemCount: number,
  height: number,
  reservedRows = 0,
): { tableRows: number; detailRows: number } {
  const available = Math.max(2, height - CHROME_ROWS - reservedRows);
  const tableRows = Math.min(
    itemCount,
    MAX_TABLE_ROWS,
    Math.max(1, Math.ceil(available / 2)),
  );
  return { tableRows, detailRows: Math.max(0, available - tableRows) };
}

/** `│ content…pad │` — ANSI-aware fill to the exact overlay width. */
function boxLine(content: string, width: number, color: Colorize): string {
  const inner = Math.max(1, width - 4);
  const clipped = truncateToWidth(content, inner);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
  return `${color("dim", "│ ")}${clipped}${pad}${color("dim", " │")}`;
}

/** `╭─ label ────╮` — a border row with an embedded (pre-colored) label. */
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

/** Render-time knobs the stateful component supplies; all optional so tests
 * can render a bare snapshot. */
export interface OverlayView {
  color?: Colorize;
  /** High-water mark of detail rows, so the pane never shrinks. */
  minDetailRows?: number;
  /** Extra rows below the detail pane (the steer composer). */
  composerLines?: string[];
  /** Replaces the footer hints (e.g. while composing). */
  footerOverride?: string;
  /** First detail line to show; "end" follows the newest line. Defaults to
   * the natural edge for the item's `detailWindow`. */
  detailOffset?: number | "end";
  /** Receives the resolved scroll geometry, so the caller can clamp state. */
  onDetailGeometry?: (geometry: { offset: number; maxOffset: number }) => void;
}

/**
 * Pure layout: title border, scrolling table window with a ▸ marker,
 * separator with the selected item's metadata, detail pane, footer border.
 * Testable with plainColorize; every line fits `width`.
 */
export function renderOverlay<T>(
  spec: OverlaySpec<T>,
  items: T[],
  selected: number,
  width: number,
  height: number,
  view: OverlayView = {},
): string[] {
  const {
    color = plainColorize,
    minDetailRows = 0,
    composerLines = [],
    footerOverride,
    detailOffset,
    onDetailGeometry,
  } = view;
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(
      edgeLine(["╭", "╮"], color("accent", chrome(spec.title)), width, color),
    );
    lines.push(boxLine(color("dim", chrome(spec.emptyText)), width, color));
    lines.push(boxLine("", width, color));
    lines.push(
      edgeLine(
        ["╰", "╯"],
        color("dim", footerOverride ?? chrome(spec.footer)),
        width,
        color,
      ),
    );
    return lines;
  }

  const index = clamp(selected, 0, items.length - 1);
  const item = items[index] as T;
  const { tableRows, detailRows } = paneRows(
    items.length,
    height,
    composerLines.length,
  );

  const title = `${chrome(spec.title)} (${index + 1}/${items.length})`;
  lines.push(edgeLine(["╭", "╮"], color("accent", title), width, color));

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

  lines.push(edgeLine(["├", "┤"], spec.headerLine(item, color), width, color));

  const detail = spec.detail(item, color);
  const { shown, offset, maxOffset } = windowDetail(
    detail,
    detailRows,
    detailOffset ?? (spec.detailWindow?.(item) === "tail" ? "end" : 0),
    color,
  );
  onDetailGeometry?.({ offset, maxOffset });
  // Pad to the floor so the pane never shrinks while browsing (no layout
  // shift on the rows above; the box only ever grows downward).
  const floor = clamp(minDetailRows, 0, detailRows);
  for (const line of shown) lines.push(boxLine(line, width, color));
  for (let i = shown.length; i < floor; i++)
    lines.push(boxLine("", width, color));

  for (const line of composerLines) lines.push(boxLine(line, width, color));

  // Breathing room: the footer hints are chrome, not content, and butting them
  // straight against the last detail row makes the two hard to tell apart.
  lines.push(boxLine("", width, color));

  const hints = footerOverride ?? spec.footerFor?.(item) ?? chrome(spec.footer);
  lines.push(
    edgeLine(
      ["╰", "╯"],
      color(
        "dim",
        // Only advertise scrolling when there is something to scroll to.
        maxOffset > 0 && footerOverride === undefined
          ? `${hints} · ⇧↑↓ scroll`
          : hints,
      ),
      width,
      color,
    ),
  );
  return lines;
}

/** The focused overlay component: selection state, keys, live refresh. */
export class SplitPaneOverlay<T> implements Component {
  private readonly tui: TUI;
  private readonly color: Colorize;
  private readonly spec: OverlaySpec<T>;
  private readonly done: () => void;
  private selectedKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private composer: { spec: OverlayComposer; input: Input } | undefined;
  /** High-water mark of detail rows shown, so the pane never shrinks. */
  private detailFloor = 0;
  /** First detail line to show; "end" follows the newest line. Reset when the
   * selection or drill level changes, so a new pane starts at its natural
   * edge instead of inheriting a stale offset. */
  private detailOffset: number | "end" = 0;
  /** Scroll geometry from the last render, so key handling can clamp without
   * recomputing the layout. */
  private detailScroll = { offset: 0, maxOffset: 0, rows: 1 };
  /** Identity the current offset belongs to (selection + window mode). */
  private detailAnchor: string | undefined;

  constructor(
    tui: TUI,
    color: Colorize,
    spec: OverlaySpec<T>,
    done: () => void,
  ) {
    this.tui = tui;
    this.color = color;
    this.spec = spec;
    this.done = done;
  }

  private currentIndex(items: T[]): number {
    if (this.selectedKey === undefined) return 0;
    const index = items.findIndex(
      (item) => this.spec.keyOf(item) === this.selectedKey,
    );
    return index >= 0 ? index : 0;
  }

  private select(items: T[], index: number): void {
    const item = items[clamp(index, 0, items.length - 1)];
    this.selectedKey = item !== undefined ? this.spec.keyOf(item) : undefined;
  }

  /** Move the detail window by `delta` rows (page-sized when |delta| > 1). */
  private scrollDetail(delta: number): void {
    const { offset, maxOffset } = this.detailScroll;
    if (maxOffset === 0) return;
    const next = clamp(offset + delta, 0, maxOffset);
    // Sticking to the bottom re-arms follow mode, so a live tail keeps
    // tracking new output after the user scrolls back down to it.
    this.detailOffset = next >= maxOffset && this.follows() ? "end" : next;
  }

  /** Whether the selected item's detail pane is a followed live tail. */
  private follows(): boolean {
    const items = this.spec.items();
    const item = items[this.currentIndex(items)];
    return item !== undefined && this.spec.detailWindow?.(item) === "tail";
  }

  private close(): void {
    this.dispose();
    this.done();
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
    const items = this.spec.items();
    this.syncTimer();
    const index = this.currentIndex(items);
    this.select(items, index);
    // Self-cap: the panel mounts in the editor slot, so every row it renders
    // pushes the transcript up. Stay under ~80% of the terminal to keep some
    // conversation visible above, with an 8-row floor so the split pane is
    // still usable on short terminals (it always fits: the floor only wins
    // when the terminal is tiny, where there is nothing to preserve anyway).
    // Detail longer than the budget scrolls (shift+↑↓, page keys) rather than
    // pushing the panel taller.
    const height = Math.max(
      8,
      Math.min(
        this.tui.terminal.rows - 6,
        Math.floor(this.tui.terminal.rows * 0.8),
      ),
    );
    const item = items[index];
    let detailRows = 1;
    if (item !== undefined) {
      detailRows = paneRows(
        items.length,
        height,
        this.composer ? 1 : 0,
      ).detailRows;
      const needed = this.spec.detail(item, this.color).length;
      this.detailFloor = clamp(
        Math.max(this.detailFloor, needed),
        0,
        detailRows,
      );
      // A different row (or a tail toggle) gets a fresh window.
      const anchor = `${this.spec.keyOf(item)}\u0000${this.spec.detailWindow?.(item) ?? "head"}`;
      if (anchor !== this.detailAnchor) {
        this.detailAnchor = anchor;
        this.detailOffset =
          this.spec.detailWindow?.(item) === "tail" ? "end" : 0;
      }
    }
    const composerLines = this.composer
      ? [
          `${this.color("accent", `${this.composer.spec.label}:`)} ${renderInlineInput(this.composer.input, Math.max(1, width - this.composer.spec.label.length - 8))}`,
        ]
      : [];
    return renderOverlay(this.spec, items, index, width, height, {
      color: this.color,
      minDetailRows: this.detailFloor,
      composerLines,
      footerOverride: this.composer ? "enter send · esc cancel" : undefined,
      detailOffset: this.detailOffset,
      onDetailGeometry: ({ offset, maxOffset }) => {
        this.detailScroll = {
          offset,
          maxOffset,
          rows: Math.max(1, detailRows),
        };
      },
    });
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.apply(this.spec.onCancel ? this.spec.onCancel() : "close");
      this.tui.requestRender();
      return;
    }
    const items = this.spec.items();
    if (items.length === 0) return;
    const index = this.currentIndex(items);
    // Detail-pane scrolling: shift+arrows by a line, page keys by a pane.
    // Plain arrows and j/k stay on the table so the primary navigation and
    // the single-letter actions keep their meaning.
    const key = parseKey(data) ?? data;
    const page = Math.max(1, this.detailScroll.rows - 1);
    if (key === "shift+up" || key === "ctrl+y") {
      this.scrollDetail(-1);
    } else if (key === "shift+down" || key === "ctrl+e") {
      this.scrollDetail(1);
    } else if (key === "shift+pageUp" || key === "ctrl+u") {
      this.scrollDetail(-page);
    } else if (key === "shift+pageDown" || key === "ctrl+d") {
      this.scrollDetail(page);
    } else if (key === "shift+home") {
      this.detailOffset = 0;
    } else if (key === "shift+end") {
      this.detailOffset = this.follows() ? "end" : this.detailScroll.maxOffset;
    } else if (keybindings.matches(data, "tui.select.up") || data === "k") {
      this.select(items, index - 1);
    } else if (keybindings.matches(data, "tui.select.down") || data === "j") {
      this.select(items, index + 1);
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.select(items, index - MAX_TABLE_ROWS);
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.select(items, index + MAX_TABLE_ROWS);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      this.act("enter", items[index] as T);
    } else {
      if (/^[a-z]$/.test(key)) this.act(key, items[index] as T);
    }
    this.tui.requestRender();
  }

  private act(key: string, item: T): void {
    this.apply(this.spec.onAction(key, item));
  }

  private apply(action: OverlayAction): void {
    if (action === "close") this.close();
    else if (action && "selectKey" in action)
      this.selectedKey = action.selectKey;
    else if (action && "compose" in action) {
      const input = new Input();
      input.focused = true;
      input.onEscape = () => {
        this.composer = undefined;
        this.tui.requestRender();
      };
      input.onSubmit = (value) => {
        const composer = this.composer;
        this.composer = undefined;
        if (composer) void Promise.resolve(composer.spec.submit(value));
        this.tui.requestRender();
      };
      this.composer = { spec: action.compose, input };
    }
  }

  invalidate(): void {
    // Stateless rendering: every render() re-reads the spec's items.
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Open the split-pane panel and resolve when the user dismisses it.
 *
 * Pass the run widget to mute the live summary for as long as the panel is
 * open: it renders directly above the composer slot the panel occupies and
 * repeats the run state the panel already shows.
 */
export async function openOverlay<T>(
  ctx: Pick<ExtensionContext, "ui">,
  spec: OverlaySpec<T>,
  widget?: Pick<RunWidget, "setSuppressed">,
): Promise<void> {
  widget?.setSuppressed(true);
  try {
    // No `overlay: true`: the panel mounts in the editor slot where the
    // composer was — the same placement pi uses for /settings and /model — so
    // it appears exactly where the user was typing instead of floating at the
    // top of a tall terminal. The host restores the editor and its focus when
    // done() fires. The component budgets its own height from terminal.rows.
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      return new SplitPaneOverlay(tui, color, spec, () => done(undefined));
    });
  } finally {
    // finally: a throwing panel must not leave the summary muted for the
    // rest of the session.
    widget?.setSuppressed(false);
  }
}
