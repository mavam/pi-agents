import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
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
function setup() {
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
  const editor = receiver("editor");
  tui.addChild(editor.component);
  tui.setFocus(editor.component);
  const agent: AgentInfo = {
    id: "1",
    name: "reviewer",
    task: "review",
    cwd: "/repo",
    state: "working",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE },
    activity: {},
  };
  const service = {
    list: () => [agent],
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
      getEditorText: () => "",
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

describe("real overlay input dispatch", () => {
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

  for (const mechanism of ["visible callback", "setHidden"] as const) {
    test(`an overlay hidden by ${mechanism} does not block panel navigation`, () => {
      const ui = setup();
      let visible = true;
      try {
        const picker = receiver("picker");
        const handle = ui.tui.showOverlay(picker.component, {
          visible: () => visible,
        });
        ui.press(LEFT);
        expect(picker.inputs).toEqual([LEFT]);
        if (mechanism === "visible callback") visible = false;
        else handle.setHidden(true);
        expect(ui.tui.hasOverlay()).toBe(false);
        ui.press(LEFT);
        expect(ui.panel.isFocused()).toBe(true);
        expect(picker.inputs).toEqual([LEFT]);
        if (mechanism === "visible callback") visible = true;
        else handle.setHidden(false);
        ui.press(RIGHT);
        expect(ui.panel.isFocused()).toBe(false);
        expect(picker.inputs).toEqual([LEFT, RIGHT]);
      } finally {
        ui.close();
      }
    });
  }

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
