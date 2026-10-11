import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import type { SessionHost } from "../../src/pi/session.js";
import { FocusController } from "../../src/ui/focus.js";
import type { AgentPanel } from "../../src/ui/panel.js";

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
    setFocused: (value: boolean) => {
      state.focused = value;
      focused.push(value);
    },
  } as unknown as AgentPanel;
  const service = {
    list: () => Array.from({ length: state.agents }),
  } as unknown as AgentService;
  const host = { current: () => service } as unknown as SessionHost;
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
  return { press, focused, browsed, focus };
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

  test("the question picker owns keys until it closes", () => {
    const { press, focused, browsed, focus } = setup({
      rows: true,
      agents: 2,
      suppressed: false,
      focused: true,
    });
    focus.setQuestionPickerActive(true);
    expect(focused).toEqual([false]);
    for (const key of [LEFT, "\u001b[A", "\u001b[B", "\r", "\t", "s", " "]) {
      expect(press(key)).toBeUndefined();
    }
    focus.focusPanel();
    expect(focused).toEqual([false]);
    expect(browsed).toEqual([]);
    focus.setQuestionPickerActive(false);
    expect(press(LEFT)).toEqual({ consume: true });
    expect(focused).toEqual([false, true]);
  });

  test("the question picker prevents browsing when the panel is empty", () => {
    const { press, browsed, focus } = setup({
      rows: false,
      agents: 2,
      suppressed: false,
    });
    focus.setQuestionPickerActive(true);
    expect(press(LEFT)).toBeUndefined();
    focus.focusPanel();
    expect(browsed).toEqual([]);
    focus.setQuestionPickerActive(false);
    expect(press(LEFT)).toEqual({ consume: true });
    expect(browsed).toHaveLength(1);
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
