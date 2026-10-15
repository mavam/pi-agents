/**
 * Compact pi-fancy-footer summary of the session's agents: `2◉ 1● 3◌`, each
 * glyph in its status color.
 * Closed agents count too, because messaging one opens it again; closed
 * helpers don't, because nobody can message them.
 *
 * This speaks the event protocol directly: pi-agents does not depend on
 * pi-fancy-footer, and the producer owns all update timing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "../agents/types.js";
import { STATUS_STYLES, statusCounts } from "./format.js";

const FANCY_FOOTER_AGENTS_WIDGET_ID = "pi-agents.agents";

const FANCY_FOOTER_PROTOCOL = 1;
const FANCY_FOOTER_WIDGET_EVENT = "pi-fancy-footer:widget";
const FANCY_FOOTER_READY_EVENT = "pi-fancy-footer:ready";

interface Span {
  text: string;
  color?: (typeof STATUS_STYLES)[keyof typeof STATUS_STYLES]["color"];
}

/** Counts per status, the counts in the text color and the glyphs in their
 * status color; none without agents. */
export function footerSpans(agents: readonly AgentInfo[]): Span[] {
  return statusCounts(agents).flatMap(([status, count], index): Span[] => {
    const style = STATUS_STYLES[status];
    return [
      { text: `${index > 0 ? " " : ""}${count}` },
      { text: style.icon, color: style.color },
    ];
  });
}

/** The spans' plain text: `2◉ 1●`. */
export function formatFooterSummary(agents: readonly AgentInfo[]): string {
  return footerSpans(agents)
    .map((span) => span.text)
    .join("");
}

export class FancyFooterReporter {
  private lastKey: string | undefined;
  private readonly stopReady: () => void;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    /** The agents Pi can reach, closed ones included. */
    private readonly agents: () => readonly AgentInfo[],
  ) {
    this.stopReady = pi.events.on(FANCY_FOOTER_READY_EVENT, (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("protocol" in message) ||
        message.protocol !== FANCY_FOOTER_PROTOCOL
      )
        return;
      this.update(true);
    });
    // Covers the footer installing its listener first; the ready handler
    // covers the opposite load order.
    this.update(true);
  }

  /** Publish only when the summary changes, unless ready forces it. */
  update(force = false): void {
    if (this.disposed) return;
    const spans = footerSpans(this.agents());
    const text = spans.map((span) => span.text).join("");
    const key = JSON.stringify(spans);
    if (!force && this.lastKey === key) return;
    this.lastKey = key;
    this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "upsert",
      widget: {
        id: FANCY_FOOTER_AGENTS_WIDGET_ID,
        label: "agents",
        description: "Shows the session's pi-agents agents by state.",
        content: { type: "text", text, spans },
        icon: false,
        style: { textColor: "text" },
        layout: {
          enabled: false,
          row: 1,
          // Left of the model, which sits at 6.
          position: 4,
          align: "right",
          fill: "none",
        },
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopReady();
    this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "remove",
      id: FANCY_FOOTER_AGENTS_WIDGET_ID,
    });
  }
}
