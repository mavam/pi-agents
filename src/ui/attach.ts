/**
 * The attach view: an agent's durable conversation rendered with Pi's own
 * message and tool components, plus an editor that talks to the agent.
 *
 * `ChatView` renders a pi-durable `ConversationView`. This module is the
 * one frontend place that reads pi-durable view types.
 *
 * Tool calls draw with Pi's renderers for Pi's tools and with
 * `agentToolViews` for the agents' own tools, such as `agent_spawn` and
 * `agent_send`, and for codemode, whose running calls come from the live
 * nested calls.
 *
 * Messages, received and sent, show as the same cards as in Pi's
 * transcript, never as the user's input; everything queued shows dim below
 * the conversation.
 *
 * Keys: ⏎ prompts an idle agent and steers a working one, Alt+⏎ queues a
 * follow-up, Esc interrupts a working agent and detaches from an idle one,
 * ← or Ctrl+D on an empty editor detach, Ctrl+O expands tool output, and
 * Shift+↑↓ and Shift+PgUp/PgDn scroll. In fullscreen mode, the mouse wheel
 * over the pane scrolls too, and clicks reach the transcript's cards, which
 * expand and collapse on their own as in Pi; regular mode leaves the mouse
 * to the terminal.
 */

import type { AttachedReplicatedState } from "@earendil-works/chord";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  CustomEditor,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionContext,
  getMarkdownTheme,
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type {
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";
import {
  type Component,
  Container,
  Loader,
  parseKey,
  Spacer,
  Text,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  INPUT_KINDS,
  type InputEntry,
  type InputOrigin,
  inputOrigin,
} from "../agents/inputs.js";
import type { AgentService } from "../agents/service.js";
import { WAIT_TOOL } from "../agents/spawning.js";
import type { AgentInfo } from "../agents/types.js";
import { expandableCard } from "./expandable.js";
import {
  type Colorize,
  fitLine,
  formatUsage,
  QUEUED_NOTE,
  shortModel,
  statusIcon,
} from "./format.js";
import {
  firstLine,
  type MessageParts,
  type MessageStyle,
  messageCard,
  messageLine,
  themeStyle,
} from "./messages.js";
import { agentToolViews, type ScriptCall } from "./tool-views.js";

const PANE_REFRESH_MS = 250;
const FLASH_MS = 5_000;

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions vary in schema.
type AnyDefinition = ToolDefinition<any, any>;

const RENDERERS: Record<string, (cwd: string) => AnyDefinition> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

function liveOf(view: ConversationView): LiveState {
  return (view.docs["pi.live"] ?? {}) as LiveState;
}

function inboxOf(view: ConversationView): InboxState {
  return (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
}

function userText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

const DIAGNOSTICS = /^<harness>\n([\s\S]*)\n<\/harness>$/;

/**
 * A tool result as Pi shows its own: pi-durable appends the call's
 * diagnostics for the model as a `<harness>` block, such as "Command exited
 * with code 3" after a failed bash command, which the card shows as plain
 * lines instead.
 */
export function displayedResult(result: ToolResultMessage): ToolResultMessage {
  let changed = false;
  const content = result.content.map((block) => {
    const match = block.type === "text" ? DIAGNOSTICS.exec(block.text) : null;
    if (!match) return block;
    changed = true;
    const lines = (match[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^\[(error|warning|info)\] /, ""));
    return { type: "text" as const, text: `\n${lines.join("\n")}` };
  });
  return changed ? { ...result, content } : result;
}

type InboxItem = Exclude<InboxState["items"][number], { mode: "write" }>;

/** Who sent a queued input, and its text. */
function queuedOrigin(item: InboxItem): InputOrigin {
  return inputOrigin(
    item.entry as InputEntry | undefined,
    userText(item.content as UserMessage["content"]),
  );
}

/** Queued texts of an inbox that Esc returns to the editor, steering
 * first like Pi restores them; messages from other agents and results stay
 * theirs. */
export function queuedTexts(inbox: InboxState): string[] {
  const steer: string[] = [];
  const followUp: string[] = [];
  for (const item of inbox.items) {
    if (item.mode === "write") continue;
    const origin = queuedOrigin(item);
    if (origin.kind === "message" || origin.kind === "results") continue;
    (item.mode === "steer" ? steer : followUp).push(origin.text);
  }
  return [...steer, ...followUp];
}

/** Queued inputs as the attach view shows them, in inbox order and dim:
 * messages from other agents as message lines seen from the agent,
 * everything else as `Steer:` or `Follow-up:`, like Pi. */
function queuedLines(
  inbox: InboxState,
  recipient: string,
  width: number,
  style: MessageStyle,
): string[] {
  const { color } = style;
  return inbox.items.flatMap((item) => {
    if (item.mode === "write") return [];
    const origin = queuedOrigin(item);
    if (origin.kind === "message")
      return [
        messageLine(
          {
            from: origin.from,
            to: recipient,
            text: origin.text,
            status: "queued",
          },
          width,
          style,
        ),
      ];
    if (origin.kind === "results")
      return [color("dim", `Results: ${firstLine(origin.text)}`)];
    const mode = item.mode === "steer" ? "Steer" : "Follow-up";
    return [color("dim", `${mode}: ${firstLine(origin.text)}`)];
  });
}

const ARGS_PREVIEW_CHARS = 200;

/**
 * The tool calls a running codemode call made so far, from the live nested
 * calls it owns directly, in the shape its result's details list them.
 */
export function liveScriptCalls(live: LiveState, callId: string): ScriptCall[] {
  return (live.nestedTools ?? [])
    .filter((slot) => slot.parentCallId === callId)
    .map((slot) => {
      const args = JSON.stringify(slot.arguments ?? {});
      const summary = slot.summary;
      return {
        name: slot.name,
        args:
          args === "{}"
            ? ""
            : args.length > ARGS_PREVIEW_CHARS
              ? `${args.slice(0, ARGS_PREVIEW_CHARS - 1)}…`
              : args,
        status:
          summary === undefined
            ? slot.status === "done"
              ? "ok"
              : "running"
            : summary.isError
              ? "error"
              : "ok",
        ...(summary?.durationMs !== undefined
          ? { durationMs: summary.durationMs }
          : {}),
        ...(summary?.error !== undefined ? { error: summary.error } : {}),
      };
    });
}

/** Queued messages first, then the draft, separated by blank lines. */
export function restoredEditorText(
  queued: readonly string[],
  currentText: string,
): string {
  return [...queued, currentText].filter((text) => text.trim()).join("\n\n");
}

/** Renders one durable conversation view with Pi's components. */
class ChatView {
  readonly transcript = new Container();
  /** The newest card per call ID; provider call IDs may repeat across turns. */
  private readonly tools = new Map<string, ToolExecutionComponent>();
  /** Every card shown, also older ones whose call ID a later turn reused. */
  private readonly cards: ToolExecutionComponent[] = [];
  /** Call IDs whose cards the streaming answer created; its entry takes them over. */
  private readonly streamingCalls = new Set<string>();
  private readonly renderers = new Map<string, AnyDefinition>();
  private renderedEntryIds: number[] = [];
  private streaming: AssistantMessageComponent | undefined;
  /** Tool output shown in full; Ctrl+O toggles it, like Pi. */
  private expanded = false;

  constructor(
    private readonly ui: TUI,
    private readonly cwd: string,
    private readonly theme: Theme,
    /** The agent's name, the recipient of its messages. */
    private readonly name: () => string,
  ) {
    this.views = agentToolViews(name);
  }

  /** Renderers of the agent's own tools. */
  private readonly views: ReturnType<typeof agentToolViews>;

  apply(view: ConversationView): void {
    const live = liveOf(view);
    this.syncTranscript(view.entries);
    const message = live.generation?.message as AssistantMessage | undefined;
    // A partial without its entry was dropped, for example by a retry.
    if (message === undefined && this.streaming !== undefined)
      this.rebuild(view.entries);
    if (message !== undefined) this.syncStreaming(message);
    for (const slot of live.tools ?? []) {
      if (slot.status === "pending") continue;
      const component = this.tool(slot.name, slot.callId);
      component.setArgsComplete();
      if (slot.status !== "running") continue;
      component.markExecutionStarted();
      // A script's tool calls so far, drawn like the calls its result lists.
      const calls = liveScriptCalls(live, slot.callId);
      const details = calls.length > 0 ? { calls } : slot.details;
      // Progress: output so far, and details such as what a call started.
      if (slot.output !== undefined || details !== undefined) {
        component.updateResult(
          {
            content: [{ type: "text", text: slot.output ?? "" }],
            details,
            isError: false,
          },
          true,
        );
      }
    }
    this.transcript.invalidate();
  }

  dispose(): void {
    this.discardTools();
  }

  /** Finish every card: a running bash card keeps a timer until it gets a final result. */
  private discardTools(): void {
    for (const component of this.cards)
      component.updateResult({ content: [], isError: false }, false);
    this.cards.length = 0;
    this.tools.clear();
    this.streamingCalls.clear();
  }

  private syncTranscript(entries: readonly EntryRecord[]): void {
    // Compaction and resets replace the head of the active transcript.
    if (this.renderedEntryIds.some((id, index) => entries[index]?.id !== id))
      this.rebuild(entries);
    for (const entry of entries.slice(this.renderedEntryIds.length)) {
      this.addEntry(entry);
      this.renderedEntryIds.push(entry.id);
    }
  }

  private rebuild(entries: readonly EntryRecord[]): void {
    this.transcript.clear();
    this.discardTools();
    this.renderedEntryIds = [];
    this.streaming = undefined;
    for (const entry of entries) {
      this.addEntry(entry);
      this.renderedEntryIds.push(entry.id);
    }
  }

  private addEntry(entry: EntryRecord): void {
    const message = entry.model?.[0];
    const input =
      INPUT_KINDS.has(entry.kind) && message?.role === "user"
        ? inputOrigin(
            { kind: entry.kind, data: entry.data },
            userText(message.content),
          )
        : undefined;
    if (input?.kind === "message") {
      // The same card as in Pi's transcript, without the time: `/messages`
      // has it. Ctrl+O shows the whole text, as for tool output.
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(
        this.messageCard({
          from: input.from,
          to: this.name(),
          text: input.text,
        }),
      );
    } else if (input?.kind === "results") {
      // The results of agents it spawned, as a message to it.
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(
        this.messageCard({
          from: "results",
          to: this.name(),
          text: input.text,
        }),
      );
    } else if (input) {
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(
        new UserMessageComponent(input.text, getMarkdownTheme()),
      );
    } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const component =
        this.streaming ??
        new AssistantMessageComponent(undefined, false, getMarkdownTheme());
      if (this.streaming === undefined) this.transcript.addChild(component);
      this.streaming = undefined;
      component.updateContent(message, false);
      // Only a tool-calling answer runs its calls; an aborted, failed, or
      // truncated one never does.
      const ran = message.stopReason === "toolUse";
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const streamed = this.streamingCalls.has(content.id);
        if (!ran && !streamed) continue;
        const card = this.tool(
          content.name,
          content.id,
          content.arguments,
          !streamed,
        );
        card.setArgsComplete();
        if (!ran) {
          const text = "Not run: the answer was interrupted.";
          card.updateResult(
            { content: [{ type: "text", text }], isError: true },
            false,
          );
        }
      }
      this.streamingCalls.clear();
    } else if (
      entry.kind === "pi.tool-result" &&
      message?.role === "toolResult"
    ) {
      const result = message as ToolResultMessage;
      this.tool(result.toolName, result.toolCallId).updateResult(
        displayedResult(result),
      );
    } else if (entry.kind === "pi.compaction") {
      this.addText(this.theme.fg("muted", "[compaction]"));
      if (message?.role === "user") this.addText(userText(message.content));
    } else if (entry.kind === "pi.reset") {
      this.addText(this.theme.fg("muted", "[new context]"));
    }
  }

  private syncStreaming(message: AssistantMessage): void {
    if (this.streaming === undefined) {
      this.streaming = new AssistantMessageComponent(
        undefined,
        false,
        getMarkdownTheme(),
      );
      this.transcript.addChild(this.streaming);
    }
    this.streaming.updateContent(message, true);
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      this.tool(
        content.name,
        content.id,
        content.arguments,
        !this.streamingCalls.has(content.id),
      );
      this.streamingCalls.add(content.id);
    }
  }

  /** Show tool output in full, or collapse it again. */
  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const card of this.cards) card.setExpanded(this.expanded);
    this.transcript.invalidate();
  }

  /** A message card that a click expands or collapses, like Pi's; Ctrl+O
   * sets every card again. */
  private messageCard(parts: MessageParts): Component {
    return expandableCard(
      (expanded) => messageCard(parts, expanded, this.theme),
      () => this.expanded,
    );
  }

  private renderer(toolName: string): AnyDefinition | undefined {
    let definition = this.renderers.get(toolName);
    if (definition === undefined) {
      const views = this.views[toolName];
      const create = RENDERERS[toolName];
      if (views) definition = { name: toolName, ...views } as AnyDefinition;
      else if (create) definition = create(this.cwd);
      else return undefined;
      this.renderers.set(toolName, definition);
    }
    return definition;
  }

  /** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
  private tool(
    toolName: string,
    toolCallId: string,
    args?: unknown,
    fresh = false,
  ): ToolExecutionComponent {
    const existing = fresh ? undefined : this.tools.get(toolCallId);
    if (existing !== undefined) {
      if (args !== undefined) existing.updateArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args ?? {},
      {},
      this.renderer(toolName),
      this.ui,
      this.cwd,
    );
    component.setExpanded(this.expanded);
    this.transcript.addChild(component);
    this.cards.push(component);
    this.tools.set(toolCallId, component);
    return component;
  }

  private addText(text: string): void {
    this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(new Text(text, 1, 0));
  }
}

/** The status line of a live view, like Pi's working indicator. */
function statusText(live: LiveState): string {
  const generation = live.generation;
  const compaction = live.compactions?.[0];
  const runningTool = live.tools?.find((slot) => slot.status === "running");
  if (generation?.retry !== undefined)
    return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
  if (generation?.deferred !== undefined)
    return "Waiting for deferred response...";
  if (compaction !== undefined)
    return compaction.retry
      ? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
      : `Compacting (${compaction.reason})...`;
  // The agent waits for agents it spawned; Pi places messages only after
  // that. Esc ends the wait without stopping those agents.
  if (runningTool?.name === WAIT_TOOL)
    return "Waiting for agents; messages wait until they finish (esc stops waiting)";
  if (runningTool !== undefined)
    return `Running ${runningTool.name}... (esc to interrupt)`;
  if (live.run !== undefined) return "Working... (esc to interrupt)";
  return "";
}

/** `──────── badge ──`: a border row with a right-aligned badge. */
function badgeBorder(
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

/** Fit queued lines into a row budget, oldest first. */
function fitQueuedLines(
  queued: readonly string[],
  maxRows: number,
  color: Colorize,
): string[] {
  if (maxRows <= 0 || queued.length === 0) return [];
  if (queued.length <= maxRows) return [...queued];
  if (maxRows === 1) return [color("dim", `${queued.length} queued`)];
  const shown = queued.slice(0, maxRows - 1);
  shown.push(color("dim", `… ${queued.length - shown.length} more`));
  return shown;
}

/** Where a frame showed the transcript: from pane row `top`, `rows` of its
 * rendered lines from line `start` on, of `total`, then the newer-lines
 * note when scrolled back. */
export interface TranscriptWindow {
  top: number;
  start: number;
  rows: number;
  total: number;
  indicator: boolean;
}

/**
 * The transcript lines that fit `rows`, without trailing blank lines:
 * the newest unless scrolled back by `scrollBack` lines, which leaves the
 * last row for a note of the newer lines. Returns the scroll clamped to
 * what the lines allow.
 */
export function windowTranscript(
  lines: readonly string[],
  rows: number,
  scrollBack: number,
): {
  lines: string[];
  start: number;
  indicator: boolean;
  scrollBack: number;
  maxScroll: number;
} {
  let length = lines.length;
  while (length > 0 && (lines[length - 1] ?? "").trim() === "") length--;
  if (length <= rows)
    return {
      lines: lines.slice(0, length),
      start: 0,
      indicator: false,
      scrollBack: 0,
      maxScroll: 0,
    };
  if (scrollBack === 0)
    return {
      lines: lines.slice(length - rows, length),
      start: length - rows,
      indicator: false,
      scrollBack: 0,
      maxScroll: length - rows,
    };
  const contentRows = Math.max(1, rows - 1);
  const maxScroll = length - contentRows;
  const clamped = Math.min(scrollBack, maxScroll);
  const start = length - clamped - contentRows;
  return {
    lines: lines.slice(start, start + contentRows),
    start,
    indicator: true,
    scrollBack: clamped,
    maxScroll,
  };
}

/** What pane row `y` shows: a transcript line, by its index among all
 * rendered lines, the newer-lines note, or neither, such as the separator,
 * the status, or the editor. */
export function transcriptTarget(
  window: TranscriptWindow | undefined,
  y: number,
): number | "indicator" | undefined {
  if (!window) return undefined;
  const row = y - window.top;
  if (row < 0) return undefined;
  if (row < window.rows) return window.start + row;
  if (window.indicator && row === window.rows) return "indicator";
  return undefined;
}

/**
 * Route a pane's non-wheel mouse event: over a transcript line, to the
 * transcript at that line, whose container hands it to the card there;
 * a left click on the newer-lines note calls `follow`. Events over other
 * rows, such as the separator, the status, or the editor, pass on.
 */
export function routeTranscriptMouse(
  transcript: Component,
  window: TranscriptWindow | undefined,
  event: TuiMouseEvent,
  follow: () => void,
): TuiMouseEventResult | undefined {
  const target = transcriptTarget(window, event.y);
  if (target === undefined || window === undefined) return undefined;
  if (target === "indicator") {
    if (event.type !== "click" || event.button !== "left") return undefined;
    follow();
    return { handled: true };
  }
  return transcript.handleMouse?.({
    ...event,
    y: target,
    height: window.total,
  });
}

/** The lines scrolled back after a wheel event over the pane; Pi reports
 * scrolling up as a negative delta. */
export function wheelScrollBack(
  scrollBack: number,
  maxScroll: number,
  wheelDelta: number,
): number {
  return Math.max(0, Math.min(maxScroll, scrollBack - wheelDelta));
}

interface AgentPaneOptions {
  service: AgentService;
  agentId: string;
  state: AttachedReplicatedState<ConversationView>;
  done: () => void;
}

class AgentPane implements Component {
  private readonly editor: CustomEditor;
  private readonly chat: ChatView;
  private readonly color: Colorize;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private view: ConversationView;
  private loader: Loader | undefined;
  private loaderText = "";
  private flash: { text: string; at: number } | undefined;
  private interrupting = false;
  private disposed = false;
  /** Lines scrolled back from the bottom; 0 follows new output. */
  private scrollBack = 0;
  private maxScroll = 0;
  /** Where the last frame showed the transcript, for clicks. */
  private window: TranscriptWindow | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    keybindings: KeybindingsManager,
    private readonly options: AgentPaneOptions,
  ) {
    this.color = (name, text) => theme.fg(name, text);
    this.view = options.state.value;
    this.chat = new ChatView(
      tui,
      this.info()?.cwd ?? process.cwd(),
      theme,
      () => this.info()?.name ?? "",
    );
    this.chat.apply(this.view);
    this.unsubscribe = options.state.subscribe((value) => {
      this.view = value;
      if (this.disposed) return;
      this.chat.apply(value);
      this.tui.requestRender();
    });
    this.editor = new CustomEditor(
      tui,
      {
        borderColor: (text) => theme.fg("borderMuted", text),
        selectList: getSelectListTheme(),
      },
      keybindings,
    );
    this.editor.focused = true;
    this.editor.onSubmit = (text) => this.submit(text, "auto");
    this.editor.onEscape = () => this.escape();
    this.editor.onAction("app.tools.expand", () => {
      this.chat.toggleExpanded();
      this.tui.requestRender();
    });
    // Pi's exit key leaves the agent instead of Pi, also only while empty.
    this.editor.onCtrlD = () => this.close();
    this.editor.onAction("app.message.followUp", () =>
      this.submit(this.editor.getText(), "followUp"),
    );
    // Elapsed time, flashes, and the loader advance without commits.
    this.timer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, PANE_REFRESH_MS);
    this.timer.unref?.();
  }

  private info(): AgentInfo | undefined {
    return this.options.service.agentById(this.options.agentId);
  }

  private showFlash(text: string): void {
    this.flash = { text, at: Date.now() };
    this.tui.requestRender();
  }

  private submit(text: string, mode: "auto" | "followUp"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      this.showFlash("Commands run in the parent session; ← goes back first.");
      return;
    }
    this.editor.setText("");
    this.editor.addToHistory(text);
    void this.options.service
      .prompt(this.options.agentId, trimmed, mode)
      .catch((error) =>
        this.showFlash(error instanceof Error ? error.message : String(error)),
      );
  }

  /** Esc: interrupt a working agent, as in Pi, or go back from an idle
   * one while the editor is empty, so a draft is never lost. */
  private escape(): void {
    if (this.info()?.state !== "working") {
      if (this.editor.getText() === "") this.close();
      return;
    }
    if (this.interrupting) return;
    this.interrupting = true;
    const queued = queuedTexts(inboxOf(this.view));
    void this.options.service
      .interrupt(this.options.agentId)
      .then(() => {
        if (queued.length === 0 || this.disposed) return;
        this.editor.setText(restoredEditorText(queued, this.editor.getText()));
        this.tui.requestRender();
      })
      .catch((error) =>
        this.showFlash(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        this.interrupting = false;
      });
  }

  private close(): void {
    this.dispose();
    this.options.done();
  }

  private syncLoader(text: string): void {
    if (text === this.loaderText) return;
    this.loaderText = text;
    this.loader?.stop();
    this.loader = undefined;
    if (text)
      this.loader = new Loader(
        this.tui,
        (value) => this.theme.fg("accent", value),
        (value) => this.theme.fg("muted", value),
        text,
      );
  }

  private header(info: AgentInfo | undefined): string {
    if (!info) return " agent ";
    const parts = [
      info.name,
      info.profile,
      shortModel(info),
      info.thinking,
      formatUsage(info.usage),
      // Results wait while the user is attached, and while Pi works.
      info.queued ? QUEUED_NOTE : undefined,
    ].filter(Boolean);
    return ` ${parts.join(" ")} `;
  }

  private windowTranscript(lines: string[], rows: number): string[] {
    const shown = windowTranscript(lines, rows, this.scrollBack);
    this.scrollBack = shown.scrollBack;
    this.maxScroll = shown.maxScroll;
    this.window = {
      // Below the separator.
      top: 1,
      start: shown.start,
      rows: shown.lines.length,
      total: lines.length,
      indicator: shown.indicator,
    };
    return shown.indicator
      ? [
          ...shown.lines,
          this.color(
            "dim",
            `… +${this.scrollBack} newer lines (shift+↓ or click)`,
          ),
        ]
      : shown.lines;
  }

  render(width: number): string[] {
    const info = this.info();
    const color = this.color;
    if (this.flash && Date.now() - this.flash.at > FLASH_MS)
      this.flash = undefined;
    const stalled = info?.state === "working" ? info.stalled : undefined;
    this.syncLoader(stalled ? "" : statusText(liveOf(this.view)));

    const editorLines = this.editor.render(width);
    if (editorLines.length > 0) {
      const badge = info
        ? `${statusIcon(info, color)}${this.header(info)}`
        : this.header(info);
      editorLines[0] = fitLine(
        badgeBorder(
          badge,
          width,
          (text) => this.theme.fg("borderMuted", text),
          (text) => this.theme.fg("text", text),
        ),
        width,
      );
    }
    const statusLines = stalled
      ? [
          "",
          ` ${color(
            "warning",
            stalled === "crashed"
              ? "⚠ Stalled after repeated crashes: press r in /agents to retry (esc to interrupt)"
              : "⚠ Stalled: this pi-agents version can't run its work (esc to interrupt)",
          )}`,
        ]
      : this.loader
        ? this.loader.render(width)
        : ["", ` ${color("dim", "esc back")}`];
    const failure =
      info?.state === "failed" && info.result?.errorMessage
        ? [color("error", `⊗ ${info.result.errorMessage}`)]
        : [];
    const compaction =
      info?.compactionFailure !== undefined
        ? [color("warning", `⚠ Compaction failed: ${info.compactionFailure}`)]
        : [];
    const flash = this.flash ? [color("error", `⚠ ${this.flash.text}`)] : [];
    // An unlabelled rule like the editor's bottom border sets the pane off
    // from Pi above; the editor's badge stays the only label.
    const separator = this.theme.fg("borderMuted", "─".repeat(width));
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(4, rows - 6);
    const fixed =
      1 +
      editorLines.length +
      statusLines.length +
      failure.length +
      compaction.length +
      flash.length;
    const content = Math.max(1, budget - fixed);
    const queued = fitQueuedLines(
      queuedLines(
        inboxOf(this.view),
        info?.name ?? "",
        width - 1,
        themeStyle(this.theme),
      ),
      Math.max(0, Math.min(3, content - 3)),
      color,
    );
    const transcript = this.windowTranscript(
      this.chat.transcript.render(width),
      Math.max(1, content - queued.length),
    );
    return [
      separator,
      ...transcript.map((line) => fitLine(line, width)),
      ...statusLines.map((line) => fitLine(line, width)),
      ...failure.map((line) => fitLine(line, width)),
      ...compaction.map((line) => fitLine(line, width)),
      ...queued.map((line) => fitLine(line, width)),
      ...flash.map((line) => fitLine(line, width)),
      ...editorLines,
    ];
  }

  handleInput(data: string): void {
    const key = parseKey(data) ?? data;
    if (key === "shift+up" || key === "ctrl+y") {
      this.scrollBack = Math.min(this.scrollBack + 1, this.maxScroll);
    } else if (key === "shift+down" || key === "ctrl+e") {
      this.scrollBack = Math.max(0, this.scrollBack - 1);
    } else if (key === "shift+pageUp") {
      this.scrollBack = Math.min(this.scrollBack + 10, this.maxScroll);
    } else if (key === "shift+pageDown") {
      this.scrollBack = Math.max(0, this.scrollBack - 10);
    } else if (key === "left" && this.editor.getText() === "") {
      this.close();
      return;
    } else {
      this.editor.handleInput(data);
    }
    this.tui.requestRender();
  }

  /** Pi routes mouse events only in fullscreen mode. Wheel events over the
   * pane scroll its transcript instead of Pi's. Other events over the
   * transcript reach its cards, as Pi's own components handle them; a click
   * on the newer-lines note follows new output again. Everything else
   * passes on. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      if (!event.wheelDelta) return undefined;
      this.scrollBack = wheelScrollBack(
        this.scrollBack,
        this.maxScroll,
        event.wheelDelta,
      );
      return { handled: true };
    }
    return routeTranscriptMouse(
      this.chat.transcript,
      this.window,
      event,
      () => {
        this.scrollBack = 0;
      },
    );
  }

  invalidate(): void {
    this.chat.transcript.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.loader?.stop();
    this.chat.dispose();
    this.options.state.dispose();
  }
}

/** Attach to an agent in the editor slot until the user detaches. */
export async function openAgentPane(
  ctx: ExtensionContext,
  service: AgentService,
  agentId: string,
): Promise<void> {
  const state = await service.view(agentId);
  // The pane draws its own status line; hide Pi's working loader for the
  // parent session so only one spinner shows.
  ctx.ui.setWorkingVisible(false);
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new AgentPane(tui, theme, keybindings, {
          service,
          agentId,
          state,
          done: () => done(undefined),
        }),
    );
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
}
