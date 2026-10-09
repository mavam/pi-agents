/**
 * The attach view: an agent's durable conversation rendered with Pi's own
 * message and tool components, plus an editor that talks to the agent.
 *
 * `ChatView` ports Pi's `ExperimentalChatView` (coding-agent
 * `src/experimental/client-tui-chat.ts`), which renders a pi-durable
 * `ConversationView`. It keeps that structure so an upstream export can
 * replace it. This module is the one frontend place that reads pi-durable
 * view types.
 *
 * Keys: ⏎ prompts an idle agent and steers a working one, Alt+⏎ queues a
 * follow-up, Esc interrupts a working agent, ← on an empty editor detaches,
 * and Shift+↑↓ and Shift+PgUp/PgDn scroll.
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
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DELEGATE_TOOL } from "../agents/delegation.js";
import type { AgentService } from "../agents/service.js";
import { type AgentInfo, USER_MESSAGE_PREFIX } from "../agents/types.js";
import {
  type Colorize,
  fitLine,
  formatUsage,
  QUEUED_NOTE,
  shortModel,
  statusIcon,
} from "./format.js";

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

/** The text as the user typed it, without the marker the agent sees. */
export function withoutUserPrefix(text: string): string {
  return text.startsWith(USER_MESSAGE_PREFIX)
    ? text.slice(USER_MESSAGE_PREFIX.length)
    : text;
}

/** Queued user texts of an inbox, steering first like Pi restores them. */
export function queuedTexts(inbox: InboxState): string[] {
  const steer: string[] = [];
  const followUp: string[] = [];
  for (const item of inbox.items) {
    if (item.mode === "write") continue;
    const text = withoutUserPrefix(
      userText(item.content as UserMessage["content"]),
    );
    (item.mode === "steer" ? steer : followUp).push(text);
  }
  return [...steer, ...followUp];
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

  constructor(
    private readonly ui: TUI,
    private readonly cwd: string,
    private readonly theme: Theme,
  ) {}

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
      if (slot.output !== undefined) {
        component.updateResult(
          {
            content: [{ type: "text", text: slot.output }],
            details: slot.details,
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
    if (entry.kind === "pi.user" && message?.role === "user") {
      this.transcript.addChild(new Spacer(1));
      this.transcript.addChild(
        new UserMessageComponent(
          withoutUserPrefix(userText(message.content)),
          getMarkdownTheme(),
        ),
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
      this.tool(result.toolName, result.toolCallId).updateResult(result);
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

  private renderer(toolName: string): AnyDefinition | undefined {
    let definition = this.renderers.get(toolName);
    if (definition === undefined) {
      const create = RENDERERS[toolName];
      if (create === undefined) return undefined;
      definition = create(this.cwd);
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
  // The agent waits for its helpers; Pi places messages only after that.
  if (runningTool?.name === DELEGATE_TOOL)
    return "Waiting for helpers; messages wait until they finish (esc stops them, ← back)";
  if (runningTool !== undefined)
    return `Running ${runningTool.name}... (esc to interrupt, ← back)`;
  if (live.run !== undefined) return "Working... (esc to interrupt, ← back)";
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

/** Fit queued messages into a row budget, oldest first. */
function formatQueuedLines(
  queued: readonly string[],
  maxRows: number,
  color: Colorize,
): string[] {
  if (maxRows <= 0 || queued.length === 0) return [];
  const line = (text: string) =>
    color("dim", `↻ Queued: ${text.split("\n")[0] ?? ""}`);
  if (queued.length <= maxRows) return queued.map(line);
  if (maxRows === 1)
    return [color("dim", `↻ Queued: ${queued.length} messages`)];
  const shown = queued.slice(0, maxRows - 1).map(line);
  shown.push(color("dim", `… ${queued.length - shown.length} more`));
  return shown;
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

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    keybindings: KeybindingsManager,
    private readonly options: AgentPaneOptions,
  ) {
    this.color = (name, text) => theme.fg(name, text);
    this.view = options.state.value;
    this.chat = new ChatView(tui, this.info()?.cwd ?? process.cwd(), theme);
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
    return this.options.service.get(this.options.agentId);
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

  private escape(): void {
    if (this.info()?.state !== "working" || this.interrupting) return;
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
    return ` ${parts.join(" · ")} `;
  }

  private windowTranscript(lines: string[], rows: number): string[] {
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
    if (lines.length <= rows) {
      this.maxScroll = 0;
      this.scrollBack = 0;
      return lines;
    }
    if (this.scrollBack === 0) {
      this.maxScroll = lines.length - rows;
      return lines.slice(-rows);
    }
    const contentRows = Math.max(1, rows - 1);
    this.maxScroll = lines.length - contentRows;
    this.scrollBack = Math.min(this.scrollBack, this.maxScroll);
    const end = lines.length - this.scrollBack;
    return [
      ...lines.slice(end - contentRows, end),
      this.color("dim", `… +${this.scrollBack} newer lines (shift+↓)`),
    ];
  }

  render(width: number): string[] {
    const info = this.info();
    const color = this.color;
    if (this.flash && Date.now() - this.flash.at > FLASH_MS)
      this.flash = undefined;
    this.syncLoader(statusText(liveOf(this.view)));

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
    const statusLines = this.loader
      ? this.loader.render(width)
      : ["", ` ${color("dim", "← back")}`];
    const failure =
      info?.state === "failed" && info.result?.errorMessage
        ? [color("error", `✗ ${info.result.errorMessage}`)]
        : [];
    const flash = this.flash ? [color("error", `⚠ ${this.flash.text}`)] : [];
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(4, rows - 6);
    const fixed =
      editorLines.length + statusLines.length + failure.length + flash.length;
    const content = Math.max(1, budget - fixed);
    const queued = formatQueuedLines(
      queuedTexts(inboxOf(this.view)),
      Math.max(0, Math.min(3, content - 3)),
      color,
    );
    const transcript = this.windowTranscript(
      this.chat.transcript.render(width),
      Math.max(1, content - queued.length),
    );
    return [
      ...transcript.map((line) => fitLine(line, width)),
      ...statusLines.map((line) => fitLine(line, width)),
      ...failure.map((line) => fitLine(line, width)),
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
