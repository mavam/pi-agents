import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type Terminal,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AgentService } from "../../src/agents/service.js";
import { type AgentInfo, EMPTY_USAGE } from "../../src/agents/types.js";
import type { SessionHost } from "../../src/pi/session.js";
import { FocusController } from "../../src/ui/focus.js";
import { AgentPanel } from "../../src/ui/panel.js";

const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";

function receiver(text: string) {
  const inputs: string[] = [];
  const component: Component = {
    render: () => [text],
    invalidate: () => {},
    handleInput: (data) => inputs.push(data),
  };
  return { component, inputs };
}

/** Bridge a terminal device and extension UI calls to Pi's real TUI. */
function setup({ closed = false } = {}) {
  let onInput: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    start: (input) => {
      onInput = input;
    },
    stop: () => {
      onInput = undefined;
    },
    drainInput: async () => {},
    write: () => {},
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  };
  const tui = new TuiMainScreen(terminal);
  const identity = (text: string) => text;
  const editor = {
    component: new Editor(tui, {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    }),
    inputs: [] as string[],
  };
  const handleEditorInput = editor.component.handleInput.bind(editor.component);
  editor.component.handleInput = (data) => {
    editor.inputs.push(data);
    handleEditorInput(data);
  };
  tui.addChild(editor.component);
  tui.setFocus(editor.component);
  const agent: AgentInfo = {
    id: "1",
    name: "reviewer",
    job: "review",
    cwd: "/repo",
    state: closed ? "idle" : "working",
    closed,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE },
    activity: {},
  };
  const service = {
    list: (options?: { includeClosed?: boolean }) =>
      !closed || options?.includeClosed ? [agent] : [],
    graphs: () => [],
    agentById: () => agent,
  } as unknown as AgentService;
  const host = { current: () => service } as unknown as SessionHost;
  const widgets = new Map<string, Component>();
  const theme = { fg: (_name: string, text: string) => text } as Theme;
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (listener: Parameters<TUI["addInputListener"]>[0]) =>
        tui.addInputListener(listener),
      getEditorText: () => editor.component.getText(),
      setWidget: (
        key: string,
        factory: ((tui: TUI, theme: Theme) => Component) | undefined,
      ) => {
        const previous = widgets.get(key);
        if (previous) tui.removeChild(previous);
        widgets.delete(key);
        if (!factory) return;
        const widget = factory(tui, theme);
        widgets.set(key, widget);
        tui.addChild(widget);
      },
    },
  } as unknown as ExtensionContext;
  const panel = new AgentPanel(host);
  const focus = new FocusController(host, panel);
  panel.update(ctx);
  focus.install(ctx);
  tui.start();
  return {
    tui,
    editor,
    panel,
    focus,
    ctx,
    press: (data: string) => onInput?.(data),
    close: () => {
      focus.dispose();
      panel.dispose();
      tui.stop();
    },
  };
}

describe("real focus and overlay input dispatch", () => {
  test.each([false, true])(
    "an editor-replacing selector keeps navigation (closed agents: %s)",
    (closed) => {
      const ui = setup({ closed });
      const browsed: ExtensionContext[] = [];
      ui.focus.onBrowse = (ctx) => browsed.push(ctx);
      try {
        // Pi's session tree replaces the editor instead of using an overlay.
        const selector = receiver("selector");
        ui.tui.removeChild(ui.editor.component);
        ui.tui.addChild(selector.component);
        ui.tui.setFocus(selector.component);
        expect(ui.tui.hasOverlay()).toBe(false);
        ui.press(LEFT);
        ui.press(RIGHT);
        ui.focus.focusPanel(ui.ctx);
        expect(selector.inputs).toEqual([LEFT, RIGHT]);
        expect(ui.editor.inputs).toEqual([]);
        expect(ui.panel.isFocused()).toBe(false);
        expect(browsed).toEqual([]);

        ui.tui.removeChild(selector.component);
        ui.tui.addChild(ui.editor.component);
        ui.tui.setFocus(ui.editor.component);
        ui.press(LEFT);
        expect(ui.panel.isFocused()).toBe(!closed);
        expect(browsed).toEqual(closed ? [ui.ctx] : []);
      } finally {
        ui.close();
      }
    },
  );

  test("a capturing overlay receives navigation before panel navigation resumes", () => {
    const ui = setup();
    try {
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(true);
      const picker = receiver("picker");
      const handle = ui.tui.showOverlay(picker.component);
      ui.press(LEFT);
      ui.press(RIGHT);
      ui.focus.focusPanel(ui.ctx);
      expect(picker.inputs).toEqual([LEFT, RIGHT]);
      expect(ui.editor.inputs).toEqual([]);
      expect(ui.panel.isFocused()).toBe(false);
      expect(handle.isFocused()).toBe(true);
      handle.hide();
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(true);
      expect(picker.inputs).toEqual([LEFT, RIGHT]);
    } finally {
      ui.close();
    }
  });

  test("a visible overlay prevents opening /agents from an empty panel", () => {
    const ui = setup({ closed: true });
    const browsed: ExtensionContext[] = [];
    ui.focus.onBrowse = (ctx) => browsed.push(ctx);
    try {
      expect(ui.panel.hasRows()).toBe(false);
      const picker = receiver("picker");
      const handle = ui.tui.showOverlay(picker.component);
      ui.press(LEFT);
      ui.focus.focusPanel(ui.ctx);
      expect(browsed).toEqual([]);
      expect(picker.inputs).toEqual([LEFT]);
      expect(ui.editor.inputs).toEqual([]);
      handle.hide();
      ui.press(LEFT);
      expect(browsed).toEqual([ui.ctx]);
      expect(picker.inputs).toEqual([LEFT]);
    } finally {
      ui.close();
    }
  });

  test("hidden overlays allow panel navigation after Pi restores editor focus", () => {
    const ui = setup();
    let visible = true;
    try {
      const picker = receiver("picker");
      const handle = ui.tui.showOverlay(picker.component, {
        visible: () => visible,
      });
      ui.press(LEFT);
      expect(picker.inputs).toEqual([LEFT]);
      visible = false;
      expect(ui.tui.hasOverlay()).toBe(false);
      // Dynamic visibility restores focus during dispatch, after raw listeners.
      // Let Pi route that first key; only then does the editor own input again.
      ui.press(LEFT);
      expect(ui.editor.inputs).toEqual([LEFT]);
      expect(ui.panel.isFocused()).toBe(false);
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(true);
      expect(picker.inputs).toEqual([LEFT]);
      visible = true;
      ui.press(RIGHT);
      expect(ui.panel.isFocused()).toBe(false);
      expect(picker.inputs).toEqual([LEFT, RIGHT]);
      handle.setHidden(true);
      expect(ui.tui.hasOverlay()).toBe(false);
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(true);
      expect(picker.inputs).toEqual([LEFT, RIGHT]);
      handle.setHidden(false);
      ui.press(RIGHT);
      expect(ui.panel.isFocused()).toBe(false);
      expect(picker.inputs).toEqual([LEFT, RIGHT, RIGHT]);
    } finally {
      ui.close();
    }
  });

  test("a visible non-capturing overlay conservatively disables panel navigation", () => {
    const ui = setup();
    try {
      const decoration = receiver("decoration");
      const handle = ui.tui.showOverlay(decoration.component, {
        nonCapturing: true,
      });
      expect(handle.isFocused()).toBe(false);
      ui.press(LEFT);
      ui.focus.focusPanel(ui.ctx);
      expect(ui.panel.isFocused()).toBe(false);
      expect(ui.editor.inputs).toEqual([LEFT]);
      expect(decoration.inputs).toEqual([]);
      handle.hide();
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(true);
      expect(ui.editor.inputs).toEqual([LEFT]);
    } finally {
      ui.close();
    }
  });

  test("a visible overlay that releases focus still blocks the panel", () => {
    const ui = setup();
    try {
      const picker = receiver("picker");
      const handle = ui.tui.showOverlay(picker.component);
      handle.unfocus({ target: ui.editor.component });
      expect(handle.isFocused()).toBe(false);
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(false);
      expect(ui.editor.inputs).toEqual([LEFT]);
      expect(picker.inputs).toEqual([]);
    } finally {
      ui.close();
    }
  });

  test("disposing the controller removes its terminal listener", () => {
    const ui = setup();
    try {
      ui.focus.dispose();
      ui.press(LEFT);
      expect(ui.panel.isFocused()).toBe(false);
      expect(ui.editor.inputs).toEqual([LEFT]);
    } finally {
      ui.close();
    }
  });
});
