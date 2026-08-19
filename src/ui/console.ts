/**
 * AgentConsole: a first-class interactive view onto one delegated agent.
 *
 * Attaching to a running agent opens this full-width component in the editor
 * slot (like the /workflows panel): the agent's live transcript on top —
 * task, assistant turns, tool activity — and an input line at the bottom.
 * Enter injects a prompt into the running child (delivered as steering while
 * it is mid-turn); Esc detaches and leaves the agent running. The transcript
 * follows new output unless scrolled back.
 *
 * Finished agents are attached as real pi sessions (switchSession) instead;
 * see openAgentConsoleOrSession below.
 */

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  Input,
  parseKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SpawnHandle, TranscriptItem } from "../engine/types.js";
import type { RunManager } from "../run/runs.js";
import type { NodeView } from "../run/state.js";
import { windowDetail } from "./overlay.js";
import { formatUsage, nodeDisplayName, shortId } from "./render.js";
import { STATUS_STYLES } from "./status.js";
import { type Colorize, formatElapsed } from "./widget.js";

const REFRESH_MS = 250;
/** Rows owned by the frame: title border, composer separator, composer,
 * footer border, trailing blank. */
const CHROME_ROWS = 5;

/** Greedy word wrap, ANSI-unaware by design: transcript lines are wrapped
 * before coloring so widths stay correct. */
export function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    let line = raw;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

/** Colored transcript lines for one item, wrapped to the pane width. */
export function transcriptLines(
  item: TranscriptItem,
  width: number,
  color: Colorize,
): string[] {
  switch (item.kind) {
    case "user":
      return wrapPlain(item.text, width - 2).map((line, index) =>
        color("accent", index === 0 ? `❯ ${line}` : `  ${line}`),
      );
    case "assistant": {
      const header = color(
        "muted",
        `assistant · turn ${item.turn}${item.summary ? ` — ${item.summary}` : ""}`,
      );
      return [header, ...wrapPlain(item.text, width)];
    }
    case "tool": {
      const marker =
        item.status === "running" ? "›" : item.status === "ok" ? "✓" : "✗";
      const tint =
        item.status === "running"
          ? ("warning" as const)
          : item.status === "ok"
            ? ("success" as const)
            : ("error" as const);
      const lines = [color(tint, `${marker} ${item.label}`)];
      if (item.output) {
        lines.push(
          ...wrapPlain(item.output, width - 2).map((line) =>
            color("dim", `  ${line}`),
          ),
        );
      }
      return lines;
    }
  }
}

function boxLine(content: string, width: number, color: Colorize): string {
  const inner = Math.max(1, width - 4);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(content)));
  return `${color("dim", "│ ")}${content}${pad}${color("dim", " │")}`;
}

function edgeLine(
  corners: [string, string],
  label: string,
  width: number,
  color: Colorize,
): string {
  const text = label ? ` ${label} ` : "";
  const fill = Math.max(0, width - 3 - visibleWidth(text));
  return (
    color("dim", `${corners[0]}─`) +
    text +
    color("dim", `${"─".repeat(fill)}${corners[1]}`)
  );
}

export interface AgentConsoleOptions {
  manager: RunManager;
  runId: string;
  instance: string;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  done: () => void;
}

/** The focused console component. Mounts in the editor slot. */
export class AgentConsole implements Component {
  private readonly tui: TUI;
  private readonly color: Colorize;
  private readonly opts: AgentConsoleOptions;
  private readonly input: Input;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** First transcript line to show; "end" follows the newest output. */
  private offset: number | "end" = "end";
  private scroll = { offset: 0, maxOffset: 0, rows: 1 };
  /** Last transcript snapshot, kept so a just-settled agent stays visible. */
  private lastItems: readonly TranscriptItem[] = [];
  private sending = false;

  constructor(tui: TUI, color: Colorize, opts: AgentConsoleOptions) {
    this.tui = tui;
    this.color = color;
    this.opts = opts;
    this.input = new Input();
    this.input.focused = true;
    this.input.onEscape = () => this.close();
    this.input.onSubmit = (value) => this.send(value);
    this.timer = setInterval(() => this.tui.requestRender(), REFRESH_MS);
    this.timer.unref?.();
  }

  private node(): NodeView | undefined {
    return this.opts.manager.state.runs
      .get(this.opts.runId)
      ?.nodes.get(this.opts.instance);
  }

  private handle(): SpawnHandle | undefined {
    return this.opts.manager.liveHandle(this.opts.runId, this.opts.instance);
  }

  private close(): void {
    this.dispose();
    this.opts.done();
  }

  private send(value: string): void {
    const message = value.trim();
    if (!message || this.sending) return;
    const handle = this.handle();
    if (!handle?.prompt) {
      this.opts.notify("Agent is no longer running.", "warning");
      return;
    }
    this.sending = true;
    this.input.setValue("");
    void handle
      .prompt(message)
      .catch((error) => {
        this.opts.notify(
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      })
      .finally(() => {
        this.sending = false;
        this.tui.requestRender();
      });
  }

  render(width: number): string[] {
    const color = this.color;
    const node = this.node();
    const handle = this.handle();
    if (handle?.transcript) this.lastItems = handle.transcript();
    const inner = Math.max(8, width - 4);

    const running = node?.status === "running";
    const status = node ? STATUS_STYLES[node.status] : STATUS_STYLES.running;
    const titleParts = [
      node ? nodeDisplayName(node) : this.opts.instance,
      node?.agent ?? "ad-hoc",
      color(status.color, `${status.icon} ${node?.status ?? "running"}`),
      node ? formatElapsed((node.endedAt ?? Date.now()) - node.startedAt) : "",
      formatUsage(node?.usage ?? node?.progressUsage) || "",
      color("dim", `run ${shortId(this.opts.runId)}`),
    ].filter(Boolean);
    const title = `${color("accent", "✦ ")}${titleParts.join(color("dim", " · "))}`;

    const lines: string[] = [];
    for (const item of this.lastItems) {
      if (lines.length > 0) lines.push("");
      lines.push(...transcriptLines(item, inner, color));
    }
    if (lines.length === 0) {
      lines.push(color("dim", running ? "waiting for output…" : "(no output)"));
    }
    if (node && node.status !== "running") {
      lines.push("");
      lines.push(
        node.error
          ? color("error", `✗ ${node.error}`)
          : color(
              "success",
              `● agent ${node.status} — result recorded in the workflow`,
            ),
      );
    }

    const height = Math.max(
      10,
      Math.min(
        this.tui.terminal.rows - 4,
        Math.floor(this.tui.terminal.rows * 0.8),
      ),
    );
    const paneRows = Math.max(3, height - CHROME_ROWS);
    const { shown, offset, maxOffset } = windowDetail(
      lines,
      paneRows,
      this.offset,
      color,
    );
    if (this.offset !== "end") this.offset = offset;
    this.scroll = { offset, maxOffset, rows: paneRows };

    const out: string[] = [];
    out.push(edgeLine(["╭", "╮"], title, width, color));
    for (const line of shown) out.push(boxLine(line, width, color));
    for (let i = shown.length; i < paneRows; i++)
      out.push(boxLine("", width, color));
    const composer = running
      ? `${color("accent", "❯")} ${this.input.render(Math.max(4, width - 8))[0]?.replace(/^> /, "") ?? ""}`
      : color("dim", "agent settled — esc closes · ⏎ opens its session");
    out.push(boxLine(composer, width, color));
    const hints = running
      ? "⏎ send · shift+↑↓ scroll · ctrl+x abort · esc detach"
      : node?.sessionFile
        ? "⏎ open session · shift+↑↓ scroll · esc close"
        : "shift+↑↓ scroll · esc close";
    out.push(edgeLine(["╰", "╯"], color("dim", hints), width, color));
    out.push("");
    return out;
  }

  /** Result of enter on a settled agent: the caller opens the session. */
  onOpenSession: (() => void) | undefined;

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    const key = parseKey(data) ?? data;
    const page = Math.max(1, this.scroll.rows - 1);
    const scrollBy = (delta: number): void => {
      if (this.scroll.maxOffset === 0) return;
      const next = Math.max(
        0,
        Math.min(this.scroll.offset + delta, this.scroll.maxOffset),
      );
      this.offset = next >= this.scroll.maxOffset ? "end" : next;
    };
    if (key === "shift+up" || key === "ctrl+y") scrollBy(-1);
    else if (key === "shift+down" || key === "ctrl+e") scrollBy(1);
    else if (key === "shift+pageUp" || key === "ctrl+u") scrollBy(-page);
    else if (key === "shift+pageDown" || key === "ctrl+d") scrollBy(page);
    else if (key === "ctrl+x") {
      const node = this.node();
      if (node?.status === "running") {
        this.handle()?.abort();
        this.opts.notify("Aborting agent…", "info");
      }
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    } else if (
      keybindings.matches(data, "tui.select.confirm") &&
      this.node()?.status !== "running"
    ) {
      const open = this.onOpenSession;
      this.close();
      open?.();
      return;
    } else {
      this.input.handleInput(data);
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    // Stateless rendering: every render() re-reads live state.
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Whether a node can be attached at all (live console or native session). */
export function canAttachNode(
  manager: RunManager,
  runId: string,
  node: NodeView,
): boolean {
  if (node.status === "running")
    return manager.liveHandle(runId, node.instance) !== undefined;
  return node.sessionFile !== undefined;
}

/**
 * Attach to one agent: a live console for a running agent, a real pi session
 * (switchSession) for a settled one. Switching tears down the extension
 * runtime — and with it every live run — so it is guarded by a confirm when
 * anything is still running.
 */
export async function openAgentConsoleOrSession(
  ctx: ExtensionContext,
  manager: RunManager,
  runId: string,
  instance: string,
  onOpen?: (open: boolean) => void,
): Promise<void> {
  const node = manager.state.runs.get(runId)?.nodes.get(instance);
  if (!node) return;
  if (node.status !== "running") {
    await openAgentSession(ctx, manager, node);
    return;
  }
  if (!manager.liveHandle(runId, instance)) {
    ctx.ui.notify("Agent is no longer attachable.", "warning");
    return;
  }
  onOpen?.(true);
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const color: Colorize = (name, text) => theme.fg(name, text);
      const console = new AgentConsole(tui, color, {
        manager,
        runId,
        instance,
        notify: (message, type) => ctx.ui.notify(message, type),
        done: () => done(undefined),
      });
      console.onOpenSession = () => {
        void openAgentSession(ctx, manager, node);
      };
      return console;
    });
  } finally {
    onOpen?.(false);
  }
}

/** Open a settled agent's own session as the active pi session. */
export async function openAgentSession(
  ctx: ExtensionContext,
  manager: RunManager,
  node: NodeView,
): Promise<void> {
  if (!node.sessionFile) {
    ctx.ui.notify("This agent has no session file to open.", "warning");
    return;
  }
  // switchSession lives on the command context; interactive pi hands the
  // same context object to event handlers, so probe for it at runtime.
  const command = ctx as Partial<ExtensionCommandContext> & ExtensionContext;
  if (typeof command.switchSession !== "function") {
    ctx.ui.notify(`Open it manually: pi --session ${node.sessionFile}`, "info");
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
