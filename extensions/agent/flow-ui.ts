import type {
  ExtensionCommandContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  SelectList,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { LiveRunRegistry } from "./live-runs.js";
import {
  formatFlowTree,
  formatOutput,
  formatRunStatus,
  resolveFlowId,
} from "./presentation.js";
import { getOrderedRuns, getRunNodes, type RunRuntimeState } from "./state.js";
import type { FlowNodeResult } from "./types.js";

export type FlowAction = "inspect" | "watch" | "mermaid" | "stop";

export interface FlowActionSelection {
  action: FlowAction;
  runId: string;
}

interface FlowListEntry {
  id: string;
  label: string;
  status: string;
  running: boolean;
}

function getFlowEntries(
  runtimeState: RunRuntimeState,
  liveRuns: LiveRunRegistry,
  runningOnly: boolean,
): FlowListEntry[] {
  return getOrderedRuns(runtimeState)
    .filter((run) => !runningOnly || liveRuns.has(run.id))
    .slice(0, 20)
    .map((run) => ({
      id: run.id,
      label: run.label,
      status: formatRunStatus(run),
      running: liveRuns.has(run.id),
    }));
}

function pickerTitle(defaultAction: FlowAction): string {
  switch (defaultAction) {
    case "inspect":
      return "Select a flow";
    case "watch":
      return "Select a running flow to watch";
    case "mermaid":
      return "Select a flow for Mermaid output";
    case "stop":
      return "Select a running flow to stop";
  }
}

function pickerHint(
  defaultAction: FlowAction,
  selection: FlowListEntry | undefined,
): string {
  const defaultLabel =
    defaultAction === "inspect"
      ? "Enter inspect"
      : defaultAction === "watch"
        ? "Enter watch"
        : defaultAction === "mermaid"
          ? "Enter Mermaid"
          : "Enter stop";
  const dynamic = selection?.running
    ? " • w watch • m mermaid • s stop"
    : " • m mermaid";
  return `${defaultLabel}${dynamic} • Esc cancel`;
}

function resultSummary(result: FlowNodeResult | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.output === "string") {
    const line = result.output
      .split("\n")
      .find((entry) => entry.trim())
      ?.trim();
    return line || "(empty)";
  }
  try {
    return JSON.stringify(result.output, null, 2);
  } catch {
    return formatOutput(result.output);
  }
}

function countNodeStatuses(
  runtimeState: RunRuntimeState,
  runId: string,
): string {
  const counts = {
    queued: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
  };
  for (const node of getRunNodes(runtimeState, runId)) {
    counts[node.status] += 1;
  }
  return [
    counts.running > 0 ? `${counts.running} running` : undefined,
    counts.waiting > 0 ? `${counts.waiting} waiting` : undefined,
    counts.completed > 0 ? `${counts.completed} completed` : undefined,
    counts.failed > 0 ? `${counts.failed} failed` : undefined,
    counts.aborted > 0 ? `${counts.aborted} aborted` : undefined,
    counts.queued > 0 ? `${counts.queued} queued` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function replaceRunningIcons(lines: string[], spinner: string): string[] {
  return lines.map((line) => line.replaceAll("⠹", spinner));
}

class FlowActionPickerComponent implements Component {
  private readonly entriesById = new Map<string, FlowListEntry>();
  private readonly list: SelectList;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    entries: FlowListEntry[],
    private readonly defaultAction: FlowAction,
    private readonly done: (result: FlowActionSelection | undefined) => void,
  ) {
    for (const entry of entries) {
      this.entriesById.set(entry.id, entry);
    }
    this.list = new SelectList(
      entries.map((entry) => ({
        value: entry.id,
        label: `${entry.label} · ${entry.id.slice(0, 8)}`,
        description: entry.status,
      })),
      10,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.bold(theme.fg("accent", text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("dim", text),
      },
    );
  }

  invalidate(): void {
    this.list.invalidate();
  }

  private selection(): FlowListEntry | undefined {
    const item = this.list.getSelectedItem();
    return item ? this.entriesById.get(item.value) : undefined;
  }

  private submit(action: FlowAction): void {
    const selection = this.selection();
    if (!selection) return;
    if (!selection.running && (action === "watch" || action === "stop")) return;
    this.done({ action, runId: selection.id });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submit(this.defaultAction);
      return;
    }
    if (data === "w") {
      this.submit("watch");
      return;
    }
    if (data === "m") {
      this.submit("mermaid");
      return;
    }
    if (data === "s") {
      this.submit("stop");
      return;
    }
    this.list.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const title = pickerTitle(this.defaultAction);
    const selection = this.selection();
    const hint = pickerHint(this.defaultAction, selection);
    const lines = [
      this.theme.bold(this.theme.fg("accent", title)),
      this.theme.fg("dim", hint),
      "",
      ...this.list.render(width),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class FlowWatchComponent implements Component {
  private frame = 0;
  private notice: string | undefined;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly runtimeState: RunRuntimeState,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runId: string,
    private readonly done: () => void,
  ) {
    this.interval = setInterval(() => {
      this.frame += 1;
      this.tui.requestRender();
    }, 80);
    this.interval.unref?.();
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.interval);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (data === "s") {
      if (this.liveRuns.stop(this.runId)) {
        this.notice = "Stopping flow...";
      } else {
        this.notice = "Flow is no longer running.";
      }
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const run = this.runtimeState.runs.get(this.runId);
    if (!run) {
      return [
        truncateToWidth(
          this.theme.fg("error", `Flow ${this.runId} is no longer available.`),
          width,
        ),
      ];
    }

    const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "⠹";
    const tree = replaceRunningIcons(
      formatFlowTree(run.flow, this.runtimeState, run.id),
      spinner,
    );
    const lines: string[] = [
      this.theme.bold(this.theme.fg("accent", `Watching ${run.label}`)),
      this.theme.fg("muted", `${run.id.slice(0, 8)} · ${formatRunStatus(run)}`),
      "",
      ...tree,
    ];

    const summary = countNodeStatuses(this.runtimeState, run.id);
    if (summary) {
      lines.push("", this.theme.fg("muted", summary));
    }
    const result = resultSummary(run.result);
    if (result && run.status !== "running") {
      lines.push("", this.theme.fg("toolOutput", result));
    }
    if (run.error) {
      lines.push("", this.theme.fg("error", run.error));
    }
    if (this.notice) {
      lines.push("", this.theme.fg("warning", this.notice));
    }

    lines.push("");
    lines.push(
      this.theme.fg(
        "dim",
        run.status === "running" ? "Esc detach • s stop" : "Esc close",
      ),
    );

    const maxWidth = Math.max(1, width);
    return lines.flatMap((line) =>
      line.length === 0
        ? [""]
        : wrapLineWithContinuation(line, maxWidth).map((entry) =>
            truncateToWidth(entry, maxWidth),
          ),
    );
  }
}

function wrapLineWithContinuation(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, width);
}

export function hasRunnableFlows(
  runtimeState: RunRuntimeState,
  liveRuns: LiveRunRegistry,
): boolean {
  return getOrderedRuns(runtimeState).some((run) => liveRuns.has(run.id));
}

export async function pickFlowAction(
  ctx: ExtensionCommandContext,
  runtimeState: RunRuntimeState,
  liveRuns: LiveRunRegistry,
  defaultAction: FlowAction,
): Promise<FlowActionSelection | undefined> {
  const entries = getFlowEntries(
    runtimeState,
    liveRuns,
    defaultAction === "watch" || defaultAction === "stop",
  );
  if (entries.length === 0) {
    return undefined;
  }
  return await ctx.ui.custom<FlowActionSelection | undefined>(
    (tui, theme, _kb, done) =>
      new FlowActionPickerComponent(tui, theme, entries, defaultAction, done),
  );
}

export async function watchFlow(
  ctx: ExtensionCommandContext,
  runtimeState: RunRuntimeState,
  liveRuns: LiveRunRegistry,
  runId: string,
): Promise<void> {
  const resolved = resolveFlowId(runtimeState, runId);
  if ("error" in resolved) {
    ctx.ui.notify(resolved.error, "warning");
    return;
  }
  if (!liveRuns.has(resolved.runId)) {
    ctx.ui.notify("Only running flows can be watched live.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new FlowWatchComponent(
        tui,
        theme,
        runtimeState,
        liveRuns,
        resolved.runId,
        () => done(),
      ),
  );
}
