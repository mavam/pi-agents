/**
 * Compact pi-fancy-footer summary for active runs.
 *
 * This intentionally speaks the event protocol directly: pi-agents does not
 * depend on pi-fancy-footer, and the producer owns all update timing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunManager } from "../run/runs.js";
import type { RunView } from "../run/state.js";
import { formatTokens } from "./render.js";
import { liveTokens, widgetProgress } from "./widget.js";

export const FANCY_FOOTER_RUNS_WIDGET_ID = "pi-agents.runs";

const FANCY_FOOTER_PROTOCOL = 1;
const FANCY_FOOTER_WIDGET_EVENT = "pi-fancy-footer:widget";
const FANCY_FOOTER_READY_EVENT = "pi-fancy-footer:ready";

/** One stable, non-animated summary of every active run. */
export function formatFancyFooterRunSummary(runs: Iterable<RunView>): string {
  const active = [...runs].filter((run) => run.status === "running");
  if (active.length === 0) return "";

  let done = 0;
  let total = 0;
  let tokens = 0;
  for (const run of active) {
    const progress = widgetProgress(run);
    done += progress.done;
    total += progress.total;
    tokens += liveTokens(run);
  }

  const runLabel = active.length === 1 ? "run" : "runs";
  const agentLabel = total === 1 ? "agent" : "agents";
  return `${active.length} ${runLabel} · ${done}/${total} ${agentLabel} · ${formatTokens(tokens)} tok`;
}

export class FancyFooterRunReporter {
  private lastText: string | undefined;
  private readonly stopReady: () => void;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly manager: RunManager,
  ) {
    this.stopReady = pi.events.on(FANCY_FOOTER_READY_EVENT, (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("protocol" in message) ||
        message.protocol !== FANCY_FOOTER_PROTOCOL
      ) {
        return;
      }
      this.update(true);
    });

    // Covers the case where the footer installed its listener first. The
    // ready handler above covers the opposite load order.
    this.update(true);
  }

  /** Publish only when the stable snapshot changes, unless ready forces it. */
  update(force = false): void {
    if (this.disposed) return;
    const text = formatFancyFooterRunSummary(this.manager.state.runs.values());
    if (!force && text === this.lastText) return;
    this.lastText = text;
    this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "upsert",
      widget: {
        id: FANCY_FOOTER_RUNS_WIDGET_ID,
        label: "Agent runs",
        description: "Active pi-agents runs, progress, and token usage.",
        content: { type: "text", text },
        icon: {
          glyphs: {
            nerd: "󰚩",
            emoji: "🤖",
            unicode: "◇",
            ascii: "A",
          },
          color: "accent",
        },
        style: { textColor: "text" },
        layout: {
          enabled: false,
          row: 1,
          position: 9,
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
      id: FANCY_FOOTER_RUNS_WIDGET_ID,
    });
  }
}
