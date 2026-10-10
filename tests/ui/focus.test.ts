import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
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
}) {
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const focused: boolean[] = [];
  const panel = {
    isFocused: () => state.focused === true,
    selected: () => ({ key: "agent:7" }),
    hasRows: () => state.rows,
    isSuppressed: () => state.suppressed,
    hasOverlay: () => false,
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
    messaging: () => false,
  } as unknown as SessionHost;
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (listener: typeof input) => {
        input = listener;
        return () => {};
      },
      getEditorText: () => "",
    },
  } as unknown as ExtensionContext;
  const focus = new FocusController(host, panel);
  const browsed: Array<string | undefined> = [];
  focus.onBrowse = (_context, select) => browsed.push(select);
  focus.install(ctx);
  // Distinct presses, so the duplicate-chunk guard doesn't merge them; a
  // terminal focus report is neither a key nor text.
  const press = (data: string) => {
    const result = input?.(data);
    input?.("\u001b[I");
    return result;
  };
  return { press, focused, browsed };
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

  test("Tab trades the focused panel for /agents at the same row", () => {
    const { press, focused, browsed } = setup({
      rows: true,
      agents: 2,
      suppressed: false,
      focused: true,
    });
    expect(press("\t")).toEqual({ consume: true });
    expect(focused).toEqual([false]);
    expect(browsed).toEqual(["agent:7"]);
  });
});
