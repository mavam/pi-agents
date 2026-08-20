/**
 * Native transcript rendering for one delegated agent, plus the attach
 * helpers shared by the run panel and the /workflows overlay.
 *
 * The AgentTranscriptView renders an agent's live transcript with pi's own
 * message components — the exact renderers of the main conversation
 * (AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent
 * with its background and tool-specific formatting) — so an attached agent
 * reads identically to the primary session. The view mounts inside the
 * above-editor run panel; the pi editor stays in place as the composer, with
 * typed input routed into the agent via pi's `input` event.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import type { TranscriptItem } from "../engine/types.js";
import type { RunManager } from "../run/runs.js";
import type { NodeView } from "../run/state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pi-shaped tool result for ToolExecutionComponent.updateResult. */
function toolResultPayload(item: TranscriptItem & { kind: "tool" }):
  | {
      content: Array<{ type: string; text?: string }>;
      details?: unknown;
      isError: boolean;
    }
  | undefined {
  const raw = item.result;
  if (isRecord(raw) && Array.isArray(raw.content)) {
    return {
      content: raw.content as Array<{ type: string; text?: string }>,
      details: raw.details,
      isError: item.status === "error",
    };
  }
  if (item.output !== undefined) {
    return {
      content: [{ type: "text", text: item.output }],
      isError: item.status === "error",
    };
  }
  return undefined;
}

/** Synthesize an in-flight assistant message from streamed fragments. */
function partialAssistantMessage(
  item: TranscriptItem & { kind: "assistant" },
): AssistantMessage {
  const content: Array<Record<string, unknown>> = [];
  if (item.thinking)
    content.push({ type: "thinking", thinking: item.thinking });
  content.push({ type: "text", text: item.text });
  return { role: "assistant", content } as unknown as AssistantMessage;
}

/** Change signature: the engine bumps `rev` on every content change, so
 * same-length updates (e.g. rolling tool-output windows) are still caught. */
export function itemSignature(item: TranscriptItem): string {
  return `${item.kind}:${item.rev ?? 0}`;
}

interface Slot {
  component: Component;
  signature: string;
  kind: TranscriptItem["kind"];
}

function disposeComponent(component: Component): void {
  (component as { dispose?: () => void }).dispose?.();
}

/**
 * Renders a transcript with pi's native message components, keeping one
 * component per item so streaming updates reuse existing renderers. The
 * window follows the newest output; `scrollBack` lines lift it upward.
 */
export class AgentTranscriptView {
  private readonly tui: TUI;
  private readonly cwd: string;
  private readonly slots = new Map<string, Slot>();
  /** Lines scrolled back from the bottom; 0 follows new output. */
  scrollBack = 0;
  /** Total overflow beyond the window in the last render. */
  private lastMaxScroll = 0;

  constructor(tui: TUI, cwd: string) {
    this.tui = tui;
    this.cwd = cwd;
  }

  maxScroll(): number {
    return this.lastMaxScroll;
  }

  private slotFor(item: TranscriptItem): Slot {
    const existing = this.slots.get(item.key);
    const signature = itemSignature(item);
    if (existing && existing.kind === item.kind) {
      if (existing.signature !== signature) {
        this.updateSlot(existing, item, signature);
      }
      return existing;
    }
    if (existing) disposeComponent(existing.component);
    const slot: Slot = {
      component: this.createComponent(item),
      signature,
      kind: item.kind,
    };
    this.slots.set(item.key, slot);
    return slot;
  }

  private createComponent(item: TranscriptItem): Component {
    switch (item.kind) {
      case "user":
        return new UserMessageComponent(item.text, getMarkdownTheme());
      case "notice":
        return new Text(`\u001b[2m⏹ ${item.text}\u001b[22m`, 1, 0);
      case "assistant": {
        const component = new AssistantMessageComponent(
          undefined,
          false,
          getMarkdownTheme(),
        );
        component.updateContent(
          (item.message as AssistantMessage | undefined) ??
            partialAssistantMessage(item),
          item.streaming === true,
        );
        return component;
      }
      case "tool": {
        const component = new ToolExecutionComponent(
          item.toolName,
          item.toolCallId,
          item.args ?? {},
          { showImages: false },
          undefined,
          this.tui,
          this.cwd,
        );
        component.markExecutionStarted();
        component.setArgsComplete();
        const result = toolResultPayload(item);
        if (result) component.updateResult(result, item.status === "running");
        return component;
      }
    }
  }

  private updateSlot(slot: Slot, item: TranscriptItem, signature: string) {
    slot.signature = signature;
    if (item.kind === "assistant") {
      (slot.component as AssistantMessageComponent).updateContent(
        (item.message as AssistantMessage | undefined) ??
          partialAssistantMessage(item),
        item.streaming === true,
      );
      return;
    }
    if (item.kind === "tool") {
      const component = slot.component as ToolExecutionComponent;
      const result = toolResultPayload(item);
      if (result) component.updateResult(result, item.status === "running");
      return;
    }
    // User messages and notices are immutable; recreate on the odd change.
    disposeComponent(slot.component);
    slot.component = this.createComponent(item);
  }

  /** Finalize every native component (tool renderers may hold timers). */
  dispose(): void {
    for (const slot of this.slots.values()) disposeComponent(slot.component);
    this.slots.clear();
  }

  /** Render the transcript into at most `maxRows` lines of `width` columns. */
  render(
    items: readonly TranscriptItem[],
    width: number,
    maxRows: number,
  ): string[] {
    // Drop (and finalize) slots for items that fell off the transcript.
    const alive = new Set(items.map((item) => item.key));
    for (const [key, slot] of this.slots) {
      if (alive.has(key)) continue;
      disposeComponent(slot.component);
      this.slots.delete(key);
    }

    const lines: string[] = [];
    for (const item of items) {
      const slot = this.slotFor(item);
      lines.push(...slot.component.render(width));
    }
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();

    if (lines.length <= maxRows) {
      this.lastMaxScroll = 0;
      this.scrollBack = 0;
      return lines;
    }
    // Window silently while following the tail — an "earlier lines" marker
    // carries no information the badge and scroll hint don't already. Only a
    // scrolled-back view marks the newer lines it is hiding.
    if (this.scrollBack === 0) {
      this.lastMaxScroll = lines.length - maxRows;
      return lines.slice(-maxRows);
    }
    const contentRows = Math.max(1, maxRows - 1);
    this.lastMaxScroll = lines.length - contentRows;
    this.scrollBack = Math.min(this.scrollBack, this.lastMaxScroll);
    const end = lines.length - this.scrollBack;
    const shown = lines.slice(end - contentRows, end);
    return [...shown, `… +${this.scrollBack} newer lines (shift+↓)`];
  }
}

/** Whether a node can be attached at all (live handle or native session). */
export function canAttachNode(
  manager: RunManager,
  runId: string,
  node: NodeView,
): boolean {
  if (node.status === "running")
    return manager.liveHandle(runId, node.instance) !== undefined;
  return node.sessionFile !== undefined;
}

/** Open a settled agent's own session as the active pi session.
 *
 * Session replacement is a command-context capability: pi exposes
 * switchSession only to command handlers. Callers holding a plain event
 * context (the run panel's focus controller) fall back to prefilling the
 * /agent-session command, whose handler carries the right context. */
export async function openAgentSession(
  ctx: ExtensionContext,
  manager: RunManager,
  runId: string,
  node: NodeView,
): Promise<void> {
  if (!node.sessionFile) {
    ctx.ui.notify("This agent has no session file to open.", "warning");
    return;
  }
  const command = ctx as Partial<ExtensionCommandContext> & ExtensionContext;
  if (typeof command.switchSession !== "function") {
    ctx.ui.setEditorText(
      `/agent-session ${runId.slice(0, 8)} ${node.instance}`,
    );
    ctx.ui.notify("Press ⏎ to open the agent's session.", "info");
    return;
  }
  if (manager.liveRunIds().length > 0) {
    const proceed = await ctx.ui.confirm(
      "Switch session?",
      "Switching sessions stops all running workflows. Continue?",
    );
    if (!proceed) return;
  }
  await command.switchSession(node.sessionFile);
}
