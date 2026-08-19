/**
 * FocusController: moves keyboard focus between pi's editor and the run
 * panel without owning a component. It intercepts raw terminal input (pi
 * runs these handlers before the focused component) and drives the RunPanel:
 *
 *   editor ── left (empty editor) / ctrl+q ──▶ panel
 *   panel  ── esc / → / typing ──▶ editor
 *   panel  ── ⏎ on a running agent ──▶ attached
 *   attached ── left (empty editor) ──▶ editor
 *
 * Attached mode keeps pi's editor in place as the agent's composer: the
 * panel shows the agent's transcript with pi's native message renderers, and
 * everything submitted from the editor is routed into the agent through the
 * `input` event (handleUserInput below). Esc interrupts the agent's current
 * turn — exactly like Esc in a normal pi session — left-arrow detaches, and
 * shift+↑↓ scroll. While attached, the spawn is held: an idle settle without
 * a result keeps the child promptable instead of ending the node.
 */

import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import type { RunManager } from "../run/runs.js";
import { openAgentSession } from "./console.js";
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
  /** Releases the attached spawn's settle-hold; set for the attachment. */
  private releaseHold: (() => void) | undefined;
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
    this.releaseHold?.();
    this.releaseHold = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctx = undefined;
  }

  /** Explicit entry point (ctrl+q shortcut) that works mid-composition. */
  focusPanel(ctx?: ExtensionContext): void {
    if (ctx) this.ctx = ctx;
    if (this.panel.attachedTarget() || !this.panel.hasRows()) return;
    this.panel.setFocused(true);
  }

  /** Attach the editor and panel to one agent (also used by /workflows). */
  attach(ctx: ExtensionContext, runId: string, instance: string): void {
    this.ctx = ctx;
    const node = this.manager.state.runs.get(runId)?.nodes.get(instance);
    if (!node) return;
    if (node.status !== "running") {
      void openAgentSession(ctx, this.manager, node).catch((error) => {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
      return;
    }
    const handle = this.manager.liveHandle(runId, instance);
    if (!handle) {
      ctx.ui.notify("Agent is no longer attachable.", "warning");
      return;
    }
    this.releaseHold?.();
    this.releaseHold = handle.hold?.();
    this.panel.setFocused(false);
    this.panel.setAttached({ runId, instance });
  }

  detach(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
    this.panel.setAttached(undefined);
  }

  /**
   * Route editor submissions while attached: everything the user types goes
   * to the attached agent (delivered as steering mid-turn). Slash commands
   * keep their normal meaning, so /workflows and friends stay reachable.
   * Wired into `pi.on("input", …)` by the extension entry point.
   */
  handleUserInput(event: InputEvent): InputEventResult | undefined {
    const attached = this.panel.attachedTarget();
    if (!attached || event.source !== "interactive") return undefined;
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return undefined;
    const handle = this.manager.liveHandle(attached.runId, attached.instance);
    if (!handle?.prompt) return undefined;
    const ctx = this.ctx;
    void handle.prompt(event.text).catch((error) => {
      ctx?.ui.notify(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    });
    return { action: "handled" };
  }

  private releaseToEditor(): void {
    this.panel.setFocused(false);
  }

  private handle(data: string): { consume?: boolean } | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
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

    const attached = this.panel.attachedTarget();
    if (attached) {
      // Esc means the same thing as in a normal pi session: interrupt the
      // agent's current turn. The held spawn stays alive and promptable.
      if (keybindings.matches(data, "tui.select.cancel")) {
        const handle = this.manager.liveHandle(
          attached.runId,
          attached.instance,
        );
        if (handle?.interrupt) {
          void handle.interrupt().catch((error) => {
            ctx.ui.notify(
              error instanceof Error ? error.message : String(error),
              "warning",
            );
          });
          return { consume: true };
        }
        return undefined;
      }
      // Left from an empty editor goes back to the parent context, mirroring
      // how the panel is entered.
      if (key === "left" && ctx.ui.getEditorText() === "") {
        this.detach();
        return { consume: true };
      }
      if (key === "shift+up" || key === "ctrl+y") {
        this.panel.scrollAttached(-1);
        return { consume: true };
      }
      if (key === "shift+down") {
        this.panel.scrollAttached(1);
        return { consume: true };
      }
      if (key === "shift+pageUp") {
        this.panel.scrollAttached(-10);
        return { consume: true };
      }
      if (key === "shift+pageDown") {
        this.panel.scrollAttached(10);
        return { consume: true };
      }
      // Everything else belongs to the editor, which now feeds this agent.
      return undefined;
    }

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
