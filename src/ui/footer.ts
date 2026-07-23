/**
 * Compact pi-fancy-footer summary for active runs.
 *
 * This intentionally speaks the event protocol directly: pi-agents does not
 * depend on pi-fancy-footer, and the producer owns all update timing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunManager } from "../run/runs.js";
import type { RunView } from "../run/state.js";
import { KIND_ICONS } from "./tree.js";
import { widgetProgress } from "./widget.js";

export const FANCY_FOOTER_WORKFLOWS_WIDGET_ID = "pi-agents.workflows";
export const FANCY_FOOTER_AGENTS_WIDGET_ID = "pi-agents.agents";

const FANCY_FOOTER_PROTOCOL = 1;
const FANCY_FOOTER_WIDGET_EVENT = "pi-fancy-footer:widget";
const FANCY_FOOTER_READY_EVENT = "pi-fancy-footer:ready";

export interface FancyFooterRunSummary {
  workflows: string;
  agents: string;
}

/** Stable, non-animated counts across every active run. */
export function formatFancyFooterRunSummary(
  runs: Iterable<RunView>,
): FancyFooterRunSummary {
  const active = [...runs].filter((run) => run.status === "running");
  if (active.length === 0) return { workflows: "", agents: "" };

  let done = 0;
  let total = 0;
  for (const run of active) {
    const progress = widgetProgress(run);
    done += progress.done;
    total += progress.total;
  }

  return { workflows: String(active.length), agents: `${done}/${total}` };
}

export class FancyFooterRunReporter {
  private readonly lastText = new Map<string, string>();
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
    const summary = formatFancyFooterRunSummary(
      this.manager.state.runs.values(),
    );
    this.publish(
      {
        id: FANCY_FOOTER_WORKFLOWS_WIDGET_ID,
        label: "Active workflows",
        description: "Number of active pi-agents workflow executions.",
        glyph: KIND_ICONS.workflow,
        color: "accent",
        position: 9,
      },
      summary.workflows,
      force,
    );
    this.publish(
      {
        id: FANCY_FOOTER_AGENTS_WIDGET_ID,
        label: "Agent progress",
        description: "Completed and total agents across active workflows.",
        glyph: KIND_ICONS.agent,
        color: "success",
        position: 10,
      },
      summary.agents,
      force,
    );
  }

  private publish(
    widget: {
      id: string;
      label: string;
      description: string;
      glyph: string;
      color: "accent" | "success";
      position: number;
    },
    text: string,
    force: boolean,
  ): void {
    if (!force && this.lastText.get(widget.id) === text) return;
    this.lastText.set(widget.id, text);
    this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "upsert",
      widget: {
        id: widget.id,
        label: widget.label,
        description: widget.description,
        content: { type: "text", text },
        icon: {
          glyphs: widget.glyph,
          color: widget.color,
        },
        style: { textColor: "text" },
        layout: {
          enabled: false,
          row: 1,
          position: widget.position,
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
    for (const id of [
      FANCY_FOOTER_WORKFLOWS_WIDGET_ID,
      FANCY_FOOTER_AGENTS_WIDGET_ID,
    ]) {
      this.pi.events.emit(FANCY_FOOTER_WIDGET_EVENT, {
        protocol: FANCY_FOOTER_PROTOCOL,
        type: "remove",
        id,
      });
    }
  }
}
