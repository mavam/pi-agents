/**
 * FocusController: moves keyboard focus between pi's editor and the run
 * panel without owning a component. It intercepts raw terminal input (pi
 * runs these handlers before the focused component) and drives the RunPanel:
 *
 *   editor ── left (empty editor) / ctrl+q ──▶ panel
 *   panel  ── esc / → / typing ──▶ editor
 *   panel  ── ⏎ on a running agent ──▶ AgentPane (ctx.ui.custom owns focus;
 *                                      this handler goes dormant until it
 *                                      closes)
 *
 * The AgentPane (ui/console.ts) is a single focused component in the editor
 * slot with a real embedded editor, so no input routing happens here while
 * attached.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import type { RunManager } from "../run/runs.js";
import { openAgentPane } from "./console.js";
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
  /** True while the AgentPane owns the editor slot and keyboard focus. */
  private paneOpen = false;
  /** Duplicate-delivery guard: some terminal stacks hand the same chunk to
   * input listeners twice in immediate succession. */
  private lastData = "";
  private lastDataAt = 0;
  private lastResult: { consume?: boolean } | undefined;

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
    if (this.paneOpen || !this.panel.hasRows()) return;
    this.panel.setFocused(true);
  }

  /** Attach to one agent: the AgentPane for a running agent, its own pi
   * session for a settled one (also used by the /workflows overlay). */
  attach(ctx: ExtensionContext, runId: string, instance: string): void {
    this.ctx = ctx;
    if (this.paneOpen) return;
    this.panel.setFocused(false);
    this.paneOpen = true;
    void openAgentPane(ctx, this.manager, this.panel, runId, instance)
      .catch((error) => {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      })
      .finally(() => {
        this.paneOpen = false;
      });
  }

  private releaseToEditor(): void {
    this.panel.setFocused(false);
  }

  private handle(data: string): { consume?: boolean } | undefined {
    const ctx = this.ctx;
    if (!ctx || this.paneOpen) return undefined;
    // Kitty keyboard protocol reports presses and releases separately, and
    // parseKey maps both to the same key name. Acting on releases would
    // double every navigation step; pi's own components ignore them too.
    if (isKeyRelease(data)) return undefined;
    // Belt and braces against double-stepped navigation: if the identical
    // chunk arrives again within a few milliseconds, repeat the previous
    // decision without acting again. Real key repeats are far slower.
    const now = Date.now();
    if (data === this.lastData && now - this.lastDataAt < 10) {
      this.lastDataAt = now;
      return this.lastResult;
    }
    const result = this.decide(ctx, data);
    this.lastData = data;
    this.lastDataAt = now;
    this.lastResult = result;
    return result;
  }

  private decide(
    ctx: ExtensionContext,
    data: string,
  ): { consume?: boolean } | undefined {
    const keybindings = getKeybindings();
    const key = parseKey(data) ?? data;

    if (!this.panel.isFocused()) {
      // Enter the panel only from an empty editor, so left-arrow keeps its
      // cursor-movement meaning while composing a message.
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
    this.attach(ctx, row.run.header.id, row.node.instance);
  }
}
