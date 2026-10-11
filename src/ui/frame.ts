/**
 * Frame pieces shared by the split-pane overlay (`/agents`) and the message
 * stream (`/messages`): box borders, a detail pane's lines, and the layout
 * that keeps both under most of the terminal.
 */

import {
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Colorize, plainColorize, sanitizeLine } from "./format.js";

/** Rows of the frame: title border, separator, footer border, blank row. */
const CHROME_ROWS = 4;

export type Bold = (text: string) => string;

/**
 * A line of the detail pane: text, wrapped to the pane; a divider across the
 * pane that starts a section, like the one under the table; or Markdown such
 * as an agent's result, rendered and indented, at most `maxLines` lines with
 * a dim `more` line for the rest.
 */
export type DetailLine =
  | string
  | { divider: string }
  /** Text after a lead, such as a time and a name, wrapped under itself. */
  | { lead: string; text: string }
  | {
      markdown: string;
      indent?: number;
      maxLines?: number;
      more?: (hidden: number) => string;
    };

/** A rendered row of the detail pane. */
export type PaneLine = { text: string } | { divider: string };

/** Render detail lines to the pane's inner width. */
export function renderDetail(
  lines: readonly DetailLine[],
  width: number,
  color: Colorize,
  markdownTheme: MarkdownTheme,
): PaneLine[] {
  return lines.flatMap((line): PaneLine[] => {
    if (typeof line === "string")
      return (line ? wrapTextWithAnsi(line, width) : [""]).map((text) => ({
        text,
      }));
    if ("divider" in line) return [line];
    if ("lead" in line) {
      const indent = visibleWidth(line.lead);
      const parts = wrapTextWithAnsi(line.text, Math.max(4, width - indent));
      return (parts.length > 0 ? parts : [""]).map((part, index) => ({
        text: `${index === 0 ? line.lead : " ".repeat(indent)}${part}`,
      }));
    }
    return renderMarkdown(line, width, color, markdownTheme).map((text) => ({
      text,
    }));
  });
}

function renderMarkdown(
  line: Extract<DetailLine, { markdown: string }>,
  width: number,
  color: Colorize,
  markdownTheme: MarkdownTheme,
): string[] {
  const indent = " ".repeat(line.indent ?? 0);
  const rendered = new Markdown(line.markdown, 0, 0, markdownTheme)
    .render(Math.max(1, width - indent.length))
    // Agents write the text, so only styling survives.
    .map((each) => `${indent}${sanitizeLine(each).trimEnd()}`);
  while (rendered.length > 0 && rendered.at(-1)?.trim() === "") rendered.pop();
  const max = line.maxLines ?? Number.POSITIVE_INFINITY;
  if (rendered.length <= max) return rendered;
  const hidden = rendered.length - max;
  const kept = rendered.slice(0, max);
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  return [
    ...kept,
    color("dim", `${indent}${line.more?.(hidden) ?? `… ${hidden} more lines`}`),
  ];
}

/**
 * The rows of the table and the detail pane. The overlay stays under about
 * 80% of the terminal, so some conversation stays visible, with a floor
 * that keeps it usable. The table gets up to half of it and the detail pane
 * the rest; the detail pane keeps the most rows it showed, so the table
 * doesn't move while the selection changes.
 */
export function paneLayout(
  terminalRows: number,
  items: number,
): { tableRows: number; detailRows: number } {
  const height = Math.max(
    8,
    Math.min(terminalRows - 6, Math.floor(terminalRows * 0.8)),
  );
  const available = Math.max(2, height - CHROME_ROWS);
  const tableRows = Math.min(items, Math.max(1, Math.ceil(available / 2)));
  return { tableRows, detailRows: Math.max(0, available - tableRows) };
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Window the detail lines into `rows`, marking hidden lines. Returns the
 * clamped offset and the largest offset for scrolling. */
export function windowDetail(
  detail: PaneLine[],
  rows: number,
  offset = 0,
  color: Colorize = plainColorize,
): { shown: PaneLine[]; offset: number; maxOffset: number } {
  if (rows <= 0) return { shown: [], offset: 0, maxOffset: 0 };
  if (detail.length <= rows) return { shown: detail, offset: 0, maxOffset: 0 };
  const contentRows = rows > 1 ? rows - 1 : rows;
  const maxOffset = detail.length - contentRows;
  const start = clamp(offset, 0, maxOffset);
  const below = detail.length - start - contentRows;
  const content = detail.slice(start, start + contentRows);
  if (contentRows === rows) return { shown: content, offset: start, maxOffset };
  const marker = {
    text: color(
      "dim",
      [
        start > 0 ? `… ${start} earlier lines` : undefined,
        below > 0 ? `… +${below} more lines` : undefined,
      ]
        .filter(Boolean)
        .join("  "),
    ),
  };
  return {
    shown: below === 0 ? [marker, ...content] : [...content, marker],
    offset: start,
    maxOffset,
  };
}

/** `│ content…pad │`, filled to the exact width. */
export function boxLine(
  content: string,
  width: number,
  color: Colorize,
): string {
  const inner = Math.max(1, width - 4);
  const clipped = truncateToWidth(content, inner, "…");
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
  return `${color("dim", "│ ")}${clipped}${pad}${color("dim", " │")}`;
}

/** `╭─ label ────╮`: a border row with an embedded label. */
export function edgeLine(
  corners: [string, string],
  label: string,
  width: number,
  color: Colorize,
): string {
  const text = label
    ? ` ${truncateToWidth(label, Math.max(1, width - 6), "…")} `
    : "";
  const fill = Math.max(0, width - 3 - visibleWidth(text));
  return (
    color("dim", `${corners[0]}─`) +
    text +
    color("dim", `${"─".repeat(fill)}${corners[1]}`)
  );
}

/** Hints that go first when key hints don't fit, in this order: those for
 * keys that work alike everywhere. */
const DROPPABLE_HINTS = ["⇧↑↓ ", "↑↓ ", "space ", "tab ", "s "];

/** Key hints joined with ` · `, at most `width` wide: hints for common keys
 * go first, then the row's end is cut. */
export function fitHints(hints: readonly string[], width: number): string {
  const kept = [...hints];
  const fits = () => visibleWidth(kept.join(" · ")) <= width;
  for (const prefix of DROPPABLE_HINTS) {
    if (fits()) break;
    const index = kept.findIndex((hint) => hint.startsWith(prefix));
    if (index >= 0) kept.splice(index, 1);
  }
  return truncateToWidth(kept.join(" · "), Math.max(1, width), "…");
}
