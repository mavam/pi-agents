/**
 * FocusController: moves keyboard focus between Pi's editor and the agent
 * panel without owning a component. It intercepts raw terminal input, which
 * Pi hands to extensions before the focused component:
 *
 *   editor ── ← (empty editor) / ctrl+q ──▶ panel, or /agents if it's empty
 *   panel  ── esc / → / typing ──▶ editor
 *   panel  ── ⏎ ──▶ attach view (ctx.ui.custom owns focus until it closes)
 *   panel  ◀─ tab ─▶ /agents, at the same row (back only while agents are open)
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
import { attachTarget, type Row } from "./rows.js";

/** True for text a user typed: no escape introducer, no control bytes. */
function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  const code = data.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a row stops: an agent, or a graph with its agents. */
export function stopTarget(row: Row): Pick<AgentInfo, "id" | "name" | "state"> {
  return row.kind === "agent" ? row.agent : row.graph;
}

/** Stop an agent or a graph, confirming first while it still works. */
export async function confirmAndStop(
  ctx: ExtensionContext,
  host: SessionHost,
  agent: Pick<AgentInfo, "id" | "name" | "state">,
): Promise<boolean> {
  const service = host.current();
  if (!service) return false;
  if (agent.state === "working") {
    const proceed = await ctx.ui.confirm(
      `Stop ${agent.name}?`,
      `${agent.name} is still working.`,
    );
    if (!proceed) return false;
  }
  try {
    await service.stop(agent.id);
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
  /** A stop confirmation is open; its dialog owns the keys. */
  private confirming = false;
  /** Opens `/agents`, at the row with key `select` if given: for ← and
   * Ctrl+Q while the panel is empty, and for Tab from the panel. */
  onBrowse: ((ctx: ExtensionContext, select?: string) => void) | undefined;
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
    this.lastData = "";
    this.lastDataAt = 0;
    this.lastResult = undefined;
  }

  /** Yield panel navigation to visible overlays, even non-capturing ones. */
  private yieldToOverlay(): boolean {
    if (!this.panel.hasOverlay()) return false;
    this.panel.setFocused(false);
    this.lastData = "";
    this.lastDataAt = 0;
    this.lastResult = undefined;
    return true;
  }

  /** Ctrl+Q: focus the panel, also mid-composition, or browse agents. */
  focusPanel(ctx?: ExtensionContext): void {
    if (ctx) this.ctx = ctx;
    if (this.yieldToOverlay() || this.paneOpen || this.panel.isSuppressed())
      return;
    if (this.panel.hasRows()) this.panel.setFocused(true);
    else if (this.ctx) this.browse(this.ctx);
  }

  /** Tab from `/agents`: focus the panel at the same row, if it shows it. */
  focusPanelAt(ctx: ExtensionContext, key: string): void {
    this.ctx = ctx;
    if (this.yieldToOverlay() || this.paneOpen || !this.panel.hasRows()) return;
    this.panel.select(key);
    this.panel.setFocused(true);
  }

  /** Open `/agents` when there are agents to browse; whether it did. */
  private browse(ctx: ExtensionContext): boolean {
    const agents = this.host.current()?.list({ includeClosed: true }) ?? [];
    if (!this.onBrowse || agents.length === 0) return false;
    this.onBrowse(ctx);
    return true;
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
    // Raw listeners run before the focused component. Yield to any visible
    // overlay, as well as our own attach view, confirmation, and /agents.
    if (
      !ctx ||
      this.yieldToOverlay() ||
      this.paneOpen ||
      this.confirming ||
      this.panel.isSuppressed()
    )
      return undefined;
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
      if (key !== "left" || ctx.ui.getEditorText() !== "") return undefined;
      if (this.panel.hasRows()) {
        this.panel.setFocused(true);
        return { consume: true };
      }
      // Without open agents, ← browses all of them.
      return this.browse(ctx) ? { consume: true } : undefined;
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
      const row = this.panel.selected();
      const agentId = row ? attachTarget(row) : undefined;
      if (agentId) this.attach(ctx, agentId);
      return { consume: true };
    }
    if (key === "space") {
      this.panel.toggle();
      return { consume: true };
    }
    // Tab trades the panel for /agents at the same row; Tab there trades back.
    if (key === "tab" && this.onBrowse) {
      const row = this.panel.selected();
      this.panel.setFocused(false);
      this.onBrowse(ctx, row?.key);
      return { consume: true };
    }
    if (key === "s") {
      const row = this.panel.selected();
      if (row) {
        this.confirming = true;
        void confirmAndStop(ctx, this.host, stopTarget(row)).finally(() => {
          this.confirming = false;
        });
      }
      return { consume: true };
    }
    // Typing returns focus to the editor and lands there. Escape sequences
    // and terminal replies pass through without touching focus.
    if (isPrintable(data)) this.panel.setFocused(false);
    return undefined;
  }
}
