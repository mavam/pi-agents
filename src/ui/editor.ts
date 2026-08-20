/**
 * Badge editor: pi's own CustomEditor with two changes while an agent is
 * attached — the top border carries a right-aligned reverse-video badge
 * naming that agent, and submissions are routed to the agent BEFORE pi's
 * submit pipeline runs:
 *
 *   ─────────────────────────────────── scout (researcher) · dummy-3 ──
 *   ❯ tell the agent something
 *   ────────────────────────────────────────────────────────────────────
 *
 * Routing at the editor matters: pi's idle submit path renders the message
 * into the parent transcript before the `input` extension event can swallow
 * it, so an event-level "handled" still leaves a phantom user message in the
 * parent session. Intercepting onSubmit avoids the parent pipeline entirely;
 * the `input`-event route in FocusController remains as a fallback for
 * setups where another extension owns the editor.
 *
 * This follows pi's sanctioned pattern for border status (see pi's
 * border-status-editor example): subclass CustomEditor, call super.render,
 * and rewrite only the border line. Everything else — text editing, app
 * keybindings, autocomplete — stays pi's.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunManager } from "../run/runs.js";
import type { RunPanel } from "./panel.js";
import { nodeDisplayName } from "./render.js";

/** Reverse-video wrap, so the label reads as a badge in any theme. */
function inverted(text: string): string {
  return `\u001b[7m${text}\u001b[27m`;
}

/** `──────── badge ──`: a border row with a right-aligned inverted badge. */
export function badgeBorder(
  label: string,
  width: number,
  border: (text: string) => string,
): string {
  const tail = 2;
  const fitted = truncateToWidth(label, Math.max(1, width - tail - 2), "…");
  const lead = Math.max(1, width - visibleWidth(fitted) - tail);
  return `${border("─".repeat(lead))}${inverted(fitted)}${border("─".repeat(tail))}`;
}

/**
 * Install the badge editor once per session. Skipped when another extension
 * already provides a custom editor — the run panel keeps working (with the
 * input-event fallback routing); only the badge is absent.
 */
export function installBadgeEditor(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  panel: RunPanel,
  manager: RunManager,
): void {
  if (ctx.mode !== "tui") return;
  if (ctx.ui.getEditorComponent()) return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    class BadgeEditor extends CustomEditor {
      /** pi's own submit pipeline, captured when interactive mode wires it. */
      private piSubmit: ((text: string) => void) | undefined;

      constructor() {
        super(tui, theme, keybindings);
        Object.defineProperty(this, "onSubmit", {
          get: () => (text: string) => this.submit(text),
          set: (handler: ((text: string) => void) | undefined) => {
            this.piSubmit = handler ?? undefined;
          },
          configurable: true,
        });
      }

      /** Route submissions to the attached agent; otherwise pi handles them.
       * Slash commands always go to pi so /workflows etc. stay reachable. */
      private submit(text: string): void {
        const attached = panel.attachedTarget();
        const trimmed = text.trim();
        if (!attached || !trimmed || trimmed.startsWith("/")) {
          this.piSubmit?.(text);
          return;
        }
        const node = this.managerNode(attached);
        const handle = manager.liveHandle(attached.runId, attached.instance);
        if (node?.status !== "running" || !handle?.prompt) {
          ctx.ui.notify(
            "Agent settled and takes no further input — ← goes back; /agent-session opens its session.",
            "error",
          );
          return;
        }
        this.setText("");
        this.addToHistory?.(text);
        void handle.prompt(text).catch((error) => {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "warning",
          );
        });
      }

      private managerNode(target: { runId: string; instance: string }) {
        return manager.state.runs.get(target.runId)?.nodes.get(target.instance);
      }

      override render(width: number): string[] {
        const lines = super.render(width);
        const attached = panel.attachedContext();
        if (!attached || lines.length < 2) return lines;
        const { run, node } = attached;
        const label = ` ${nodeDisplayName(node)}${node.agent ? ` (${node.agent})` : ""} · ${run.header.label ?? run.header.flow.kind} `;
        lines[0] = badgeBorder(label, width, (text) => this.borderColor(text));
        return lines;
      }
    }
    return new BadgeEditor();
  });
}
