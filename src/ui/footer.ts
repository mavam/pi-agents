/**
 * Compact pi-fancy-footer summary of open agents: `2◉ 1●`.
 *
 * This speaks the event protocol directly: pi-agents does not depend on
 * pi-fancy-footer, and the producer owns all update timing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentInfo, AgentState } from "../agents/types.js";
import { AGENT_ICON, STATE_STYLES } from "./format.js";

export const FANCY_FOOTER_AGENTS_WIDGET_ID = "pi-agents.agents";

const FANCY_FOOTER_PROTOCOL = 1;
const FANCY_FOOTER_WIDGET_EVENT = "pi-fancy-footer:widget";
const FANCY_FOOTER_READY_EVENT = "pi-fancy-footer:ready";

const ORDER: AgentState[] = ["working", "idle", "failed", "interrupted"];

/** Counts per state, empty without open agents. */
export function formatFooterSummary(agents: readonly AgentInfo[]): string {
  const counts = new Map<AgentState, number>();
  for (const agent of agents)
    counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
  return ORDER.flatMap((state) => {
    const count = counts.get(state);
    return count ? [`${count}${STATE_STYLES[state].icon}`] : [];
  }).join(" ");
}

export class FancyFooterReporter {
  private lastText: string | undefined;
  private readonly stopReady: () => void;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
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
    const text = formatFooterSummary(this.agents());
    if (!force && this.lastText === text) return;
    this.lastText = text;
    this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "upsert",
      widget: {
        id: FANCY_FOOTER_AGENTS_WIDGET_ID,
        label: "agents",
        description: "Shows open pi-agents agents by state.",
        content: { type: "text", text },
        icon: { glyphs: AGENT_ICON, color: "success" },
        style: { textColor: "text" },
        layout: {
          enabled: false,
          row: 1,
          position: 10,
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
