/**
 * Badge editor: pi's own CustomEditor with one change — while an agent is
 * attached, the editor's top border carries a right-aligned reverse-video
 * badge naming that agent, so the border itself separates the transcript
 * from the composer (no doubled rules):
 *
 *   ─────────────────────────────────── scout (researcher) · dummy-3 ──
 *   ❯ tell the agent something
 *   ────────────────────────────────────────────────────────────────────
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
 * already provides a custom editor — the run panel keeps working; only the
 * badge is absent.
 */
export function installBadgeEditor(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  panel: RunPanel,
): void {
  if (ctx.mode !== "tui") return;
  if (ctx.ui.getEditorComponent()) return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    class BadgeEditor extends CustomEditor {
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
    return new BadgeEditor(tui, theme, keybindings);
  });
}
