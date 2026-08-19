/**
 * FocusController: moves keyboard focus between pi's editor and the run
 * panel without owning a component. It intercepts raw terminal input (pi
 * runs these handlers before the focused component) and drives the RunPanel:
 *
 *   editor ── left (empty editor) / ctrl+q ──▶ panel
 *   panel  ── esc / → / typing ──▶ editor
 *   panel  ── ⏎ on an agent ──▶ console (ctx.ui.custom owns focus; the
 *                                handler goes dormant until it closes)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, parseKey } from "@earendil-works/pi-tui";
import type { RunManager } from "../run/runs.js";
import { openAgentConsoleOrSession } from "./console.js";
import type { RunPanel } from "./panel.js";

/** True for input a user typed as text: no escape introducer, no control
 * bytes. Terminal replies always start with ESC (0x1b) or contain C0 bytes. */
export function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  const code = data.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export class FocusController {
  private readonly manager: RunManager;
  private readonly panel: RunPanel;
  private ctx: ExtensionContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private consoleOpen = false;

  constructor(manager: RunManager, panel: RunPanel) {
    this.manager = manager;
    this.panel = panel;
  }

  /** (Re)attach to the session's terminal input. TUI mode only. */
  install(ctx: ExtensionContext): void {
    this.ctx = ctx;
    if (ctx.mode !== "tui") return;
    this.unsubscribe?.();
    this.unsubscribe = ctx.ui.onTerminalInput((data) => this.handle(data));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctx = undefined;
  }

  /** Explicit entry point (ctrl+q shortcut) that works mid-composition. */
  focusPanel(ctx?: ExtensionContext): void {
    if (ctx) this.ctx = ctx;
    if (this.consoleOpen || !this.panel.hasRows()) return;
    this.panel.setFocused(true);
  }

  private releaseToEditor(): void {
    this.panel.setFocused(false);
  }

  private handle(data: string): { consume?: boolean } | undefined {
    const ctx = this.ctx;
    if (!ctx || this.consoleOpen) return undefined;

    if (!this.panel.isFocused()) {
      // Enter the panel only from an empty editor, so left-arrow keeps its
      // cursor-movement meaning while composing a message.
      const key = parseKey(data) ?? data;
      if (
        key === "left" &&
        ctx.ui.getEditorText() === "" &&
        this.panel.hasRows()
      ) {
        this.panel.setFocused(true);
        return { consume: true };
      }
      return undefined;
    }

    const keybindings = getKeybindings();
    const key = parseKey(data) ?? data;
    if (keybindings.matches(data, "tui.select.cancel") || key === "right") {
      this.releaseToEditor();
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.up") || key === "up") {
      if (!this.panel.move(-1)) this.releaseToEditor();
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.down") || key === "down") {
      this.panel.move(1);
      return { consume: true };
    }
    if (data === " ") {
      this.panel.toggleExpand();
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.activate(ctx);
      return { consume: true };
    }
    if (key === "c") {
      const stopped = this.panel.cancelSelected();
      ctx.ui.notify(
        stopped ? "Stopping run…" : "Run is not live.",
        stopped ? "info" : "warning",
      );
      return { consume: true };
    }
    // Printable typing returns focus to the editor and is delivered there,
    // so starting to compose never gets swallowed by the panel. Everything
    // else — escape sequences and control bytes, including the unsolicited
    // terminal replies (cursor-position reports, focus and paste-mode
    // events) that arrive on every redraw — passes through without touching
    // focus, since none of it is the user leaving the panel.
    if (isPrintable(data)) this.releaseToEditor();
    return undefined;
  }

  private activate(ctx: ExtensionContext): void {
    const row = this.panel.selectedRow();
    if (!row) return;
    if (row.kind === "run") {
      this.panel.expandRun(row.run.header.id);
      this.panel.move(1);
      return;
    }
    const { run, node } = row;
    this.releaseToEditor();
    this.consoleOpen = true;
    this.panel.setAttached({ runId: run.header.id, instance: node.instance });
    void openAgentConsoleOrSession(
      ctx,
      this.manager,
      run.header.id,
      node.instance,
    )
      .catch((error) => {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      })
      .finally(() => {
        this.consoleOpen = false;
        this.panel.setAttached(undefined);
      });
  }
}
