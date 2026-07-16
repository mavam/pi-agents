/**
 * The above-editor widget summarizing running workflow runs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunManager } from "../run/runs.js";
import { shortId } from "./render.js";

const WIDGET_KEY = "pi-agents:runs";
const MAX_RUNS = 5;

export class RunWidget {
  private readonly manager: RunManager;
  private lastContext: ExtensionContext | undefined;

  constructor(manager: RunManager) {
    this.manager = manager;
  }

  update(ctx?: ExtensionContext): void {
    const context = ctx ?? this.lastContext;
    if (!context?.hasUI) return;
    this.lastContext = context;

    const running = [...this.manager.state.runs.values()].filter(
      (run) => run.status === "running",
    );
    if (running.length === 0) {
      context.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const lines = running.slice(0, MAX_RUNS).map((run) => {
      const nodes = [...run.nodes.values()];
      const agents = nodes.filter(
        (node) => node.kind === "agent" || node.kind === "reduce",
      );
      const done = agents.filter((node) => node.status === "completed").length;
      const active = agents
        .filter((node) => node.status === "running")
        .map((node) => node.agent)
        .filter(Boolean)
        .slice(0, 3);
      const label = run.header.label ?? run.header.flow.kind;
      const activeText = active.length > 0 ? ` — ${active.join(", ")}` : "";
      return `◉ ${shortId(run.header.id)} ${label}: ${done}/${agents.length || "?"} agents${activeText}`;
    });
    if (running.length > MAX_RUNS) {
      lines.push(`… +${running.length - MAX_RUNS} more (see /runs)`);
    }
    context.ui.setWidget(WIDGET_KEY, lines);
  }
}
