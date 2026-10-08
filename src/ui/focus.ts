/**
 * FocusController: moves keyboard focus between Pi's editor and the agent
 * panel without owning a component. It intercepts raw terminal input, which
 * Pi hands to extensions before the focused component:
 *
 *   editor ── ← (empty editor) / ctrl+q ──▶ panel
 *   panel  ── esc / → / typing ──▶ editor
 *   panel  ── ⏎ ──▶ attach view (ctx.ui.custom owns focus until it closes)
 *
 * It also owns attaching, so the panel, the overlay, and `/agent` share one
 * path that hides the panel and holds deliveries while attached.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import type { AgentInfo } from "../agents/types.js";
import type { SessionHost } from "../pi/session.js";
import { openAgentPane } from "./attach.js";
import type { AgentPanel } from "./panel.js";

/** True for text a user typed: no escape introducer, no control bytes. */
export function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  const code = data.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Close an agent, confirming first while it still works. */
export async function confirmAndClose(
  ctx: ExtensionContext,
  host: SessionHost,
  agent: AgentInfo,
): Promise<boolean> {
  const service = host.current();
  if (!service) return false;
  if (agent.state === "working") {
    const proceed = await ctx.ui.confirm(
      `Close ${agent.name}?`,
      `${agent.name} is still working. Closing stops it.`,
    );
    if (!proceed) return false;
  }
  try {
    await service.closeAgent(agent.id);
    return true;
  } catch (error) {
    ctx.ui.notify(errorText(error), "error");
    return false;
  }
}

export class FocusController {
  private ctx: ExtensionContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private paneOpen = false;
  /** Invoked after the attach view closes (deliver held results, etc.). */
  onPaneClosed: ((ctx: ExtensionContext) => void) | undefined;
  /** Some terminal stacks hand the same chunk to listeners twice. */
  private lastData = "";
  private lastDataAt = 0;
  private lastResult: { consume?: boolean } | undefined;

  constructor(
    private readonly host: SessionHost,
    private readonly panel: AgentPanel,
  ) {}

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

  /** Ctrl+Q: focus the panel, also mid-composition. */
  focusPanel(ctx?: ExtensionContext): void {
    if (ctx) this.ctx = ctx;
    if (this.paneOpen || !this.panel.hasRows()) return;
    this.panel.setFocused(true);
  }

  isPaneOpen(): boolean {
    return this.paneOpen;
  }

  /** Open the attach view for an agent. */
  attach(ctx: ExtensionContext, agentId: string): void {
    this.ctx = ctx;
    const service = this.host.current();
    if (this.paneOpen || !service) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Attaching needs the interactive TUI.", "warning");
      return;
    }
    this.panel.setFocused(false);
    this.panel.setSuppressed(true);
    this.paneOpen = true;
    void openAgentPane(ctx, service, agentId)
      .catch((error) => ctx.ui.notify(errorText(error), "error"))
      .finally(() => {
        this.paneOpen = false;
        this.panel.setSuppressed(false);
        this.onPaneClosed?.(ctx);
      });
  }

  private handle(data: string): { consume?: boolean } | undefined {
    const ctx = this.ctx;
    if (!ctx || this.paneOpen) return undefined;
    // The Kitty keyboard protocol reports releases separately; acting on
    // them would double every step.
    if (isKeyRelease(data)) return undefined;
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
      // Only from an empty editor, so ← keeps moving the cursor while typing.
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
      this.panel.setFocused(false);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.up") || key === "up") {
      if (!this.panel.move(-1)) this.panel.setFocused(false);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.down") || key === "down") {
      this.panel.move(1);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const agent = this.panel.selected();
      if (agent) this.attach(ctx, agent.id);
      return { consume: true };
    }
    if (key === "s") {
      const agent = this.panel.selected();
      const service = this.host.current();
      if (agent && service) {
        if (agent.state === "working") {
          void service
            .stop(agent.id)
            .catch((error) => ctx.ui.notify(errorText(error), "error"));
        } else ctx.ui.notify(`${agent.name} is not working.`, "info");
      }
      return { consume: true };
    }
    if (key === "x") {
      const agent = this.panel.selected();
      if (agent) void confirmAndClose(ctx, this.host, agent);
      return { consume: true };
    }
    // Typing returns focus to the editor and lands there. Escape sequences
    // and terminal replies pass through without touching focus.
    if (isPrintable(data)) this.panel.setFocused(false);
    return undefined;
  }
}
