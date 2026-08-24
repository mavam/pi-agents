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
  CustomEditor,
  type ExtensionCommandContext,
  type ExtensionContext,
  getMarkdownTheme,
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  parseKey,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  SpawnHandle,
  TranscriptItem,
  TranscriptNoticeKind,
} from "../engine/types.js";
import type { RunManager } from "../run/runs.js";
import type { NodeView, RunView } from "../run/state.js";
import { nodeDisplayName } from "./render.js";
import type { Colorize } from "./widget.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pi-shaped tool result for ToolExecutionComponent.updateResult. */
export function toolResultPayload(item: TranscriptItem & { kind: "tool" }):
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
  // Esc marks the transcript item failed before the abort round-trip returns
  // a tool result. Give Pi's native renderer an empty final error result so
  // its background changes immediately instead of remaining pending-colored.
  if (item.status === "error") {
    return { content: [], isError: true };
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

const NOTICE_ICONS = {
  interrupted: "⊘",
  "submission-deferred": "○",
  "submission-requested": "◌",
  "result-submitted": "●",
  detached: "←",
} as const satisfies Record<TranscriptNoticeKind, string>;

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
  private readonly color: Colorize;
  private readonly slots = new Map<string, Slot>();
  /** Lines scrolled back from the bottom; 0 follows new output. */
  scrollBack = 0;
  /** Total overflow beyond the window in the last render. */
  private lastMaxScroll = 0;

  constructor(tui: TUI, cwd: string, color: Colorize = (_name, text) => text) {
    this.tui = tui;
    this.cwd = cwd;
    this.color = color;
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
        return new Text(
          this.color("dim", `${NOTICE_ICONS[item.notice]} ${item.text}`),
          0,
          0,
        );
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

// ---------------------------------------------------------------------------
// The attached-agent pane: one focused component in the editor slot.

/** `──────── badge ──`: a border row with a right-aligned themed badge. */
export function badgeBorder(
  label: string,
  width: number,
  border: (text: string) => string,
  badge: (text: string) => string,
): string {
  const tail = 2;
  const fitted = truncateToWidth(label, Math.max(1, width - tail - 2), "…");
  const lead = Math.max(1, width - visibleWidth(fitted) - tail);
  return `${border("─".repeat(lead))}${badge(fitted)}${border("─".repeat(tail))}`;
}

/**
 * Neutralize characters that can desynchronize or control the terminal.
 * Preserve only CSI SGR sequences produced by pi's theme renderers. Strip
 * cursor movement, screen control, OSC/DCS/APC strings, malformed escapes,
 * tabs, and remaining C0/C1 controls from agent-provided output.
 */
export function sanitizeLine(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code === 0x1b) {
      const next = line[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < line.length) {
          const value = line.charCodeAt(end);
          if (value >= 0x40 && value <= 0x7e) break;
          if (value < 0x20 || value > 0x3f) break;
          end += 1;
        }
        if (end < line.length) {
          const final = line.charCodeAt(end);
          if (final >= 0x40 && final <= 0x7e) {
            if (line[end] === "m") result += line.slice(index, end + 1);
            index = end + 1;
            continue;
          }
        }
        // An unterminated or malformed CSI owns the rest of this line.
        break;
      }
      if (next && "]P^_X".includes(next)) {
        const stringStart = index + 2;
        const stringTerminator = line.indexOf("\u001b\\", stringStart);
        const bellTerminator =
          next === "]" ? line.indexOf("\u0007", stringStart) : -1;
        const terminators = [stringTerminator, bellTerminator].filter(
          (value) => value >= 0,
        );
        if (terminators.length === 0) break;
        const terminator = Math.min(...terminators);
        index = terminator + (terminator === bellTerminator ? 1 : 2);
        continue;
      }
      // Other ESC sequences are two-byte terminal controls. A lone ESC is
      // discarded as well.
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (code === 0x09) {
      result += "  ";
      index += 1;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    result += line[index];
    index += 1;
  }
  return result;
}

const PANE_REFRESH_MS = 250;
/** How long an inline flash message stays visible. */
const FLASH_MS = 5_000;

type UserTranscriptItem = Extract<TranscriptItem, { kind: "user" }>;

/** Fit queued prompts into a fixed row budget while keeping FIFO order. */
export function formatPendingPromptLines(
  pending: readonly UserTranscriptItem[],
  maxRows: number,
  color: Colorize = (_name, text) => text,
): string[] {
  if (maxRows <= 0 || pending.length === 0) return [];
  const lineFor = (item: UserTranscriptItem) =>
    color("dim", `↻ Queued: ${item.text.split("\n")[0] ?? ""}`);
  if (pending.length <= maxRows) return pending.map(lineFor);
  if (maxRows === 1) {
    return [color("dim", `↻ Queued: ${pending.length} messages`)];
  }
  const shown = pending.slice(0, maxRows - 1).map(lineFor);
  shown.push(color("dim", `… ${pending.length - shown.length} more`));
  return shown;
}

export interface AgentPaneOptions {
  manager: RunManager;
  runId: string;
  instance: string;
  done: () => void;
}

/**
 * The attached-agent view: the agent's transcript (pi-native rendering) and
 * a real embedded CustomEditor whose top border carries the agent badge. The
 * parent workflow overview stays hidden while this focused view is open.
 * Mounted via ctx.ui.custom() in the editor slot — the one
 * mechanism pi lays out and repaints reliably for large interactive content
 * (extension widgets in the dock are for small status lines).
 *
 * Keys: type + ⏎ talks to the agent (delivered as steering mid-turn), esc
 * interrupts its current turn, ← from an empty editor detaches, shift+↑↓
 * scroll the transcript. Errors flash inline, in sequence with the view.
 */
export class AgentPane implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly opts: AgentPaneOptions;
  private readonly editor: CustomEditor;
  private readonly view: AgentTranscriptView;
  private readonly releaseHold: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private items: readonly TranscriptItem[] = [];
  private flash: { text: string; at: number } | undefined;
  private disposed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    opts: AgentPaneOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.opts = opts;
    const run = opts.manager.state.runs.get(opts.runId);
    this.view = new AgentTranscriptView(
      tui,
      run?.header.cwd ?? process.cwd(),
      (name, text) => theme.fg(name, text),
    );
    this.editor = new CustomEditor(
      tui,
      {
        borderColor: (text) => theme.fg("borderMuted", text),
        selectList: getSelectListTheme(),
      },
      keybindings,
    );
    this.editor.focused = true;
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.onEscape = () => this.interrupt();
    this.releaseHold = this.handle()?.hold?.();
    this.timer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, PANE_REFRESH_MS);
    this.timer.unref?.();
  }

  private node(): NodeView | undefined {
    return this.opts.manager.state.runs
      .get(this.opts.runId)
      ?.nodes.get(this.opts.instance);
  }

  private run(): RunView | undefined {
    return this.opts.manager.state.runs.get(this.opts.runId);
  }

  private handle(): SpawnHandle | undefined {
    return this.opts.manager.liveHandle(this.opts.runId, this.opts.instance);
  }

  private showFlash(text: string): void {
    this.flash = { text, at: Date.now() };
    this.tui.requestRender();
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      this.showFlash("Commands run in the parent session — ← goes back first.");
      return;
    }
    const node = this.node();
    const handle = this.handle();
    if (node?.status !== "running" || !handle?.prompt) {
      this.showFlash(
        "Agent settled and takes no further input — ← goes back; /agent-session opens its session.",
      );
      return;
    }
    this.editor.setText("");
    this.editor.addToHistory(text);
    void handle.prompt(text).catch((error) => {
      this.showFlash(error instanceof Error ? error.message : String(error));
    });
  }

  private interrupt(): void {
    const handle = this.handle();
    if (this.node()?.status !== "running" || !handle?.interrupt) return;
    void handle.interrupt().catch((error) => {
      this.showFlash(error instanceof Error ? error.message : String(error));
    });
  }

  private close(): void {
    this.dispose();
    this.opts.done();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const color: Colorize = (name, text) => theme.fg(name, text);
    const run = this.run();
    const node = this.node();
    const handle = this.handle();
    if (handle?.transcript) this.items = handle.transcript();
    if (this.flash && Date.now() - this.flash.at > FLASH_MS) {
      this.flash = undefined;
    }

    // Queued prompts live in a pending block above the editor (like pi's
    // pending-message display), not in the transcript flow: their transcript
    // position is only fixed at delivery.
    const flowItems = this.items.filter(
      (item) => !(item.kind === "user" && item.queued === true),
    );
    const pending = this.items.filter(
      (item): item is UserTranscriptItem =>
        item.kind === "user" && item.queued === true,
    );

    const editorLines = this.editor.render(width);
    if (run && node && editorLines.length > 0) {
      const label = ` ${nodeDisplayName(node)}${node.profile ? ` (${node.profile})` : ""} · ${run.header.label ?? run.header.flow.kind} `;
      editorLines[0] = badgeBorder(
        label,
        width,
        (text) => theme.fg("borderMuted", text),
        (text) => theme.bg("userMessageBg", theme.fg("userMessageText", text)),
      );
    }

    // A settled agent's cause of death must be visible in the pane, not
    // buried in run details.
    const failureLine =
      node?.status === "failed" && node.error
        ? [color("error", `✗ ${node.error}`)]
        : [];

    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, rows - 6);
    const flashLines = this.flash
      ? [color("error", `⚠ ${this.flash.text}`)]
      : [];
    const fixedRows =
      editorLines.length + failureLine.length + flashLines.length;
    const contentRows = Math.max(0, Math.min(budget, rows) - fixedRows);
    const transcriptReserve =
      flowItems.length > 0 ? Math.min(3, contentRows) : 0;
    const pendingLines = formatPendingPromptLines(
      pending,
      Math.max(0, contentRows - transcriptReserve),
      color,
    );
    const transcriptRows = contentRows - pendingLines.length;
    const transcript =
      transcriptRows > 0
        ? this.view.render(flowItems, width, transcriptRows)
        : [];

    // Final clamp on every line this pane builds: an overwide line is a hard
    // crash in pi's renderer. The embedded editor's own lines are pi's and
    // already width-safe; our badge replacement on its top border is clamped.
    const clamp = (line: string) =>
      truncateToWidth(sanitizeLine(line), width, "…");
    if (editorLines.length > 0) {
      editorLines[0] = clamp(editorLines[0] ?? "");
    }
    return [
      ...transcript.map(clamp),
      ...failureLine.map(clamp),
      ...pendingLines.map(clamp),
      ...flashLines.map(clamp),
      ...editorLines,
    ];
  }

  handleInput(data: string): void {
    const key = parseKey(data) ?? data;
    if (key === "shift+up" || key === "ctrl+y") {
      this.view.scrollBack = Math.min(
        this.view.scrollBack + 1,
        this.view.maxScroll(),
      );
    } else if (key === "shift+down") {
      this.view.scrollBack = Math.max(0, this.view.scrollBack - 1);
    } else if (key === "shift+pageUp") {
      this.view.scrollBack = Math.min(
        this.view.scrollBack + 10,
        this.view.maxScroll(),
      );
    } else if (key === "shift+pageDown") {
      this.view.scrollBack = Math.max(0, this.view.scrollBack - 10);
    } else if (key === "left" && this.editor.getText() === "") {
      this.close();
      return;
    } else {
      this.editor.handleInput(data);
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    // State is pulled fresh on every render.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.releaseHold?.();
    this.view.dispose();
  }
}

/**
 * Attach to one agent: the pane for a running agent, its own pi session for
 * a settled one. Suppresses the parent run overview while the pane is open.
 */
export async function openAgentPane(
  ctx: ExtensionContext,
  manager: RunManager,
  panel: { setSuppressed(value: boolean): void },
  runId: string,
  instance: string,
): Promise<void> {
  const node = manager.state.runs.get(runId)?.nodes.get(instance);
  if (!node) return;
  if (node.status !== "running") {
    await openAgentSession(ctx, manager, runId, node);
    return;
  }
  if (!manager.liveHandle(runId, instance)) {
    ctx.ui.notify("Agent is no longer attachable.", "warning");
    return;
  }
  panel.setSuppressed(true);
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new AgentPane(tui, theme, keybindings, {
          manager,
          runId,
          instance,
          done: () => done(undefined),
        }),
    );
  } finally {
    panel.setSuppressed(false);
  }
}
