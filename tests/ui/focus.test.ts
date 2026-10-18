import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type TUI } from "@earendil-works/pi-tui";
import type { AgentService } from "../../src/agents/service.js";
import type { SessionHost } from "../../src/pi/session.js";
import { FocusController } from "../../src/ui/focus.js";
import { AgentPanel } from "../../src/ui/panel.js";

const LEFT = "\u001b[D";

/** A focus controller over a fake panel, host, and terminal. */
function setup(state: {
  rows: boolean;
  agents: number;
  suppressed: boolean;
  focused?: boolean;
  editorText?: () => string;
}) {
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const focused: boolean[] = [];
  const panel = {
    isFocused: () => state.focused === true,
    selected: () => ({ key: "agent:7" }),
    hasRows: () => state.rows,
    isSuppressed: () => state.suppressed,
    hasOverlay: () => false,
    isEditorFocused: () => true,
    setFocused: (value: boolean) => {
      state.focused = value;
      focused.push(value);
    },
  } as unknown as AgentPanel;
  const service = {
    list: () => Array.from({ length: state.agents }),
  } as unknown as AgentService;
  const host = {
    current: () => service,
  } as unknown as SessionHost;
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (listener: typeof input) => {
        input = listener;
        return () => {};
      },
      getEditorText: () => state.editorText?.() ?? "",
    },
  } as unknown as ExtensionContext;
  const focus = new FocusController(host, panel);
  const browsed: Array<string | undefined> = [];
  focus.onBrowse = (_context, select) => browsed.push(select);
  const messages: unknown[] = [];
  focus.onMessages = (_context, options) => messages.push(options);
  focus.install(ctx);
  // Distinct presses, so the duplicate-chunk guard doesn't merge them; a
  // terminal focus report is neither a key nor text.
  const press = (data: string) => {
    const result = input?.(data);
    input?.("\u001b[I");
    return result;
  };
  return { press, focused, browsed, messages };
}

describe("focus", () => {
  test("← focuses the panel when it shows agents", () => {
    const { press, focused, browsed } = setup({
      rows: true,
      agents: 2,
      suppressed: false,
    });
    expect(press(LEFT)).toEqual({ consume: true });
    expect(focused).toEqual([true]);
    expect(browsed).toEqual([]);
  });

  test.each([
    ["plain text", "hello", "hello"],
    [
      "paste",
      "\u001b[200~send instructions\nmore context\u001b[201~",
      "send instructions\nmore context",
    ],
    ["Kitty text", "\u001b[104u", "h"],
    ["Kitty Unicode text", "\u001b[252u", "ü"],
    ["modifyOtherKeys text", "\u001b[27;2;72~", "H"],
  ])("%s returns input to the parent before Enter", (_label, data, text) => {
    const identity = (value: string) => value;
    const editor = new Editor({ requestRender() {} } as TUI, {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    });
    const submitted: string[] = [];
    editor.onSubmit = (value) => submitted.push(value);
    const ui = setup({
      rows: true,
      agents: 2,
      suppressed: false,
      editorText: () => editor.getText(),
    });
    const press = (input: string) => {
      if (!ui.press(input)?.consume) editor.handleInput(input);
    };
    press(LEFT);
    press(data);
    expect(editor.getText()).toBe(text);
    expect(ui.focused).toEqual([true, false]);
    press("\r");
    expect(submitted).toEqual([text]);
  });

  test("terminal reports and key releases leave panel focus alone", () => {
    const ui = setup({ rows: true, agents: 2, suppressed: false });
    ui.press(LEFT);
    for (const data of [
      "\u001b[I",
      "\u001b[O",
      "\u001b[4;20;10t",
      "\u001b[104;1:3u",
    ]) {
      expect(ui.press(data)).toBeUndefined();
    }
    expect(ui.focused).toEqual([true]);
  });

  test("← opens /agents when the panel is empty", () => {
    const { press, focused, browsed } = setup({
      rows: false,
      agents: 3,
      suppressed: false,
    });
    expect(press(LEFT)).toEqual({ consume: true });
    expect(browsed).toHaveLength(1);
    expect(focused).toEqual([]);
  });

  test("← passes through without agents, and inside /agents", () => {
    const none = setup({ rows: false, agents: 0, suppressed: false });
    expect(none.press(LEFT)).toBeUndefined();
    expect(none.browsed).toEqual([]);
    const open = setup({ rows: true, agents: 2, suppressed: true });
    expect(open.press(LEFT)).toBeUndefined();
    expect(open.focused).toEqual([]);
  });

  test("the empty panel retains overlay detection without rendering content", () => {
    let overlay = true;
    const tui = { hasOverlay: () => overlay } as unknown as TUI;
    let widget: Component | undefined;
    const ctx = {
      mode: "tui",
      ui: {
        setWidget: (
          _key: string,
          factory: ((tui: TUI, theme: Theme) => Component) | undefined,
        ) => {
          widget = factory?.(tui, {} as Theme);
        },
      },
    } as unknown as ExtensionContext;
    const host = { current: () => undefined } as unknown as SessionHost;
    const panel = new AgentPanel(host);
    try {
      panel.update(ctx);
      expect(widget?.render(80)).toEqual([]);
      expect(panel.hasOverlay()).toBe(true);
      overlay = false;
      expect(panel.hasOverlay()).toBe(false);
      overlay = true;
      panel.setSuppressed(true);
      expect(widget?.render(80)).toEqual([]);
      expect(panel.hasOverlay()).toBe(true);
    } finally {
      panel.dispose();
    }
    expect(widget).toBeUndefined();
    expect(panel.hasOverlay()).toBe(false);
  });

  test("Tab trades the panel for /agents at the same row, Shift+Tab for /messages", () => {
    const { press, focused, browsed } = setup({
      rows: true,
      agents: 2,
      suppressed: false,
      focused: true,
    });
    expect(press("\t")).toEqual({ consume: true });
    expect(focused).toEqual([false]);
    expect(browsed).toEqual(["agent:7"]);
    // Shift+Tab goes back to /messages, instead of reaching Pi, where it
    // changes the thinking level.
    const back = setup({
      rows: true,
      agents: 2,
      suppressed: false,
      focused: true,
    });
    expect(back.press("\u001b[Z")).toEqual({ consume: true });
    expect(back.messages).toEqual([{}]);
  });
});
