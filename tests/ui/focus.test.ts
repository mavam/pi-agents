import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import type { SessionHost } from "../../src/pi/session.js";
import { FocusController } from "../../src/ui/focus.js";
import type { AgentPanel } from "../../src/ui/panel.js";

const LEFT = "\u001b[D";

/** A focus controller over a fake panel, host, and terminal. */
function setup(state: { rows: boolean; agents: number; suppressed: boolean }) {
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const focused: boolean[] = [];
  const panel = {
    isFocused: () => false,
    hasRows: () => state.rows,
    isSuppressed: () => state.suppressed,
    setFocused: (value: boolean) => focused.push(value),
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
  const browsed: unknown[] = [];
  focus.onBrowse = (context) => browsed.push(context);
  focus.install(ctx);
  // Distinct presses, so the duplicate-chunk guard doesn't merge them.
  const press = (data: string) => {
    const result = input?.(data);
    input?.("x");
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
});
