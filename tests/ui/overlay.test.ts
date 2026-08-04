import { describe, expect, test } from "bun:test";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { RunView } from "../../src/run/state.js";
import {
  type OverlaySpec,
  openOverlay,
  renderOverlay,
  SplitPaneOverlay,
} from "../../src/ui/overlay.js";
import { visibleWidgetRuns } from "../../src/ui/widget.js";

function spec(
  items: string[],
  detail: (item: string) => string[] = (item) => [`detail of ${item}`],
): OverlaySpec<string> {
  return {
    title: "Things",
    emptyText: "Nothing here.",
    footer: "hints",
    items: () => items,
    keyOf: (item) => item,
    row: (item) => `row ${item}`,
    headerLine: (item) => `header ${item}`,
    detail,
    onAction: () => undefined,
  };
}

describe("renderOverlay", () => {
  test("split-pane layout: title, marker, separator, detail, footer", () => {
    const lines = renderOverlay(
      spec(["a", "b", "c"]),
      ["a", "b", "c"],
      1,
      50,
      20,
    );
    expect(lines[0]).toContain("Things (2/3)");
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines.find((line) => line.includes("▸"))).toContain("row b");
    expect(lines.filter((line) => line.includes("▸"))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith("├"))).toContain("header b");
    expect(lines.some((line) => line.includes("detail of b"))).toBe(true);
    expect(lines.at(-2)).toContain("hints");
    expect(lines.at(-2)?.endsWith("╯")).toBe(true);
  });

  test("every line fits the requested width", () => {
    const long = "x".repeat(200);
    const lines = renderOverlay(
      spec([long, long], (item) => [item, item]),
      [long, long],
      0,
      40,
      20,
    );
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("table windows around the selection when the list is long", () => {
    const items = Array.from({ length: 30 }, (_, i) => `item${i}`);
    const lines = renderOverlay(spec(items), items, 25, 60, 30);
    expect(lines[0]).toContain("(26/30)");
    expect(lines.find((line) => line.includes("▸"))).toContain("row item25");
    expect(lines.some((line) => line.includes("row item0 "))).toBe(false);
    // Table pane is capped at 10 rows.
    expect(lines.filter((line) => line.includes("row item"))).toHaveLength(10);
  });

  test("detail pane truncates with a more-lines marker", () => {
    const detail = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const lines = renderOverlay(spec(["a"]), ["a"], 0, 60, 16);
    expect(lines.length).toBeLessThanOrEqual(16);
    const truncated = renderOverlay(
      spec(["a"], () => detail),
      ["a"],
      0,
      60,
      16,
    );
    expect(truncated.length).toBeLessThanOrEqual(16);
    expect(truncated.some((line) => line.includes("more lines"))).toBe(true);
  });

  test("tail detail keeps the newest lines visible", () => {
    const detail = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const tailSpec: OverlaySpec<string> = {
      ...spec(["a"], () => detail),
      detailWindow: () => "tail",
    };
    const lines = renderOverlay(tailSpec, ["a"], 0, 60, 12);
    expect(lines.some((line) => line.includes("earlier lines"))).toBe(true);
    expect(lines.some((line) => line.includes("line 49"))).toBe(true);
    expect(lines.some((line) => line.includes("line 0 "))).toBe(false);
  });

  test("detail pane pads to the floor so rows above never shift", () => {
    // 1 table row + 1 detail line, but a floor of 8 detail rows: top border +
    // table + separator + 8 detail rows + bottom border + trailing gap.
    const lines = renderOverlay(spec(["a"]), ["a"], 0, 60, 20, {
      minDetailRows: 8,
    });
    expect(lines).toHaveLength(13);
    expect(lines.some((line) => line.includes("detail of a"))).toBe(true);
    // The floor never exceeds the height budget.
    const capped = renderOverlay(spec(["a"]), ["a"], 0, 60, 10, {
      minDetailRows: 99,
    });
    expect(capped.length).toBeLessThanOrEqual(10);
  });

  test("detail offset scrolls the window and reports its geometry", () => {
    const detail = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const scrolled: { offset: number; maxOffset: number }[] = [];
    const lines = renderOverlay(
      spec(["a"], () => detail),
      ["a"],
      0,
      60,
      16,
      {
        detailOffset: 20,
        onDetailGeometry: (geometry) => scrolled.push(geometry),
      },
    );
    expect(lines.some((line) => line.includes("line 20"))).toBe(true);
    expect(lines.some((line) => line.includes("line 19"))).toBe(false);
    // Both directions are reported in the single marker row.
    const marker = lines.find((line) => line.includes("earlier lines"));
    expect(marker).toContain("more lines");
    expect(scrolled[0]?.offset).toBe(20);
    expect(scrolled[0]?.maxOffset).toBeGreaterThan(20);
    // Past-the-end offsets clamp to the last window.
    const end = renderOverlay(
      spec(["a"], () => detail),
      ["a"],
      0,
      60,
      16,
      {
        detailOffset: 999,
        onDetailGeometry: (geometry) => scrolled.push(geometry),
      },
    );
    expect(end.some((line) => line.includes("line 49"))).toBe(true);
    expect(end.some((line) => line.includes("more lines"))).toBe(false);
    expect(scrolled[1]?.offset).toBe(scrolled[1]?.maxOffset);
  });

  test("the footer advertises scrolling only when the detail overflows", () => {
    const detail = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const longFooter =
      "↑↓ move · ⏎ inspect · a agents · c cancel · r rerun · h hide · esc back";
    const overflowingSpec = {
      ...spec(["a"], () => detail),
      footer: longFooter,
    };
    const overflowing = renderOverlay(overflowingSpec, ["a"], 0, 60, 16);
    // The scroll hint remains visible even when the action list is truncated.
    expect(overflowing.at(-2)).toContain("scroll");
    const fitting = renderOverlay(spec(["a"]), ["a"], 0, 60, 16);
    expect(fitting.at(-2)).not.toContain("scroll");
  });

  test("empty list renders the empty text", () => {
    const lines = renderOverlay(spec([]), [], 0, 40, 20);
    // Title, text, footer border, trailing gap.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("Nothing here.");
  });

  test("a blank row separates the panel from whatever renders below it", () => {
    const lines = renderOverlay(spec(["a", "b"]), ["a", "b"], 0, 40, 20);
    expect(lines.at(-1)).toBe("");
    expect(lines.at(-2)?.endsWith("╯")).toBe(true);
    // The empty state gets the same trailing gap.
    const empty = renderOverlay(spec([]), [], 0, 40, 20);
    expect(empty.at(-1)).toBe("");
    expect(empty.at(-2)?.endsWith("╯")).toBe(true);
  });

  test("selection index is clamped", () => {
    const lines = renderOverlay(spec(["a", "b"]), ["a", "b"], 99, 40, 20);
    expect(lines.find((line) => line.includes("▸"))).toContain("row b");
  });

  test("function-valued chrome is resolved on every render", () => {
    const dynamic: OverlaySpec<string> = {
      ...spec(["a"]),
      title: () => "Mode A",
      footer: () => "keys A",
      emptyText: () => "empty A",
    };
    const lines = renderOverlay(dynamic, ["a"], 0, 50, 20);
    expect(lines[0]).toContain("Mode A (1/1)");
    expect(lines.at(-2)).toContain("keys A");
    const empty = renderOverlay(dynamic, [], 0, 50, 20);
    expect(empty[1]).toContain("empty A");
  });

  test("reserves a composer row and replaces the footer hints", () => {
    const lines = renderOverlay(spec(["a"]), ["a"], 0, 60, 14, {
      composerLines: ["Steer: revise the result"],
      footerOverride: "enter send · esc cancel",
    });
    expect(
      lines.some((line) => line.includes("Steer: revise the result")),
    ).toBe(true);
    expect(lines.at(-2)).toContain("enter send · esc cancel");
    expect(lines.length).toBeLessThanOrEqual(14);
  });

  test("keeps an overflowing one-row detail pane within its height budget", () => {
    const detail = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const lines = renderOverlay(
      spec(["a", "b"], () => detail),
      ["a", "b"],
      0,
      60,
      8,
      {
        composerLines: ["Steer:"],
        footerOverride: "enter send · esc cancel",
      },
    );
    expect(lines).toHaveLength(8);
    expect(lines.some((line) => line.includes("line 0"))).toBe(true);
  });

  test("height is elastic: grows with the detail up to the terminal budget", () => {
    const tui = {
      terminal: { rows: 50 },
      requestRender: () => {},
    } as unknown as TUI;
    const small = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a"], () => ["one", "two"]),
      () => {},
    );
    expect(small.render(60)).toHaveLength(7);
    small.dispose();

    const big = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a"], () => Array.from({ length: 100 }, (_, i) => `line ${i}`)),
      () => {},
    );
    const lines = big.render(60);
    // Fills the budget (~80% of rows), leaving the transcript above visible.
    expect(lines).toHaveLength(40);
    expect(lines.at(-2)).toContain("hints");
    expect(lines.some((line) => line.includes("more lines"))).toBe(true);
    big.dispose();
  });

  test("short terminals keep the 8-row floor and every line fits", () => {
    const tui = {
      terminal: { rows: 12 },
      requestRender: () => {},
    } as unknown as TUI;
    const panel = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a"], () => Array.from({ length: 100 }, (_, i) => `line ${i}`)),
      () => {},
    );
    const lines = panel.render(60);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.at(-2)).toContain("hints");
    // Every framed row is exact-width; the trailing gap is outside the box.
    for (const line of lines.slice(0, -1)) expect(visibleWidth(line)).toBe(60);
    expect(lines.at(-1)).toBe("");
    panel.dispose();
  });

  test("persists offsets clamped by terminal resizing", () => {
    const terminal = { rows: 50 };
    const tui = {
      terminal,
      requestRender: () => {},
    } as unknown as TUI;
    const detail = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const panel = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a"], () => detail),
      () => {},
    );
    panel.render(60);
    panel.handleInput("\x1b[1;2F"); // shift+end
    expect(panel.render(60).some((line) => line.includes("line 99"))).toBe(
      true,
    );

    terminal.rows = 100;
    const grown = panel.render(60);
    expect(grown.some((line) => line.includes("line 26"))).toBe(true);

    terminal.rows = 50;
    const shrunk = panel.render(60);
    expect(shrunk.some((line) => line.includes("line 26"))).toBe(true);
    expect(shrunk.some((line) => line.includes("line 99"))).toBe(false);
    panel.dispose();
  });

  test("openOverlay mounts in the editor slot, not as a floating overlay", async () => {
    let captured: Record<string, unknown> | undefined;
    let called = false;
    const ctx = {
      ui: {
        custom: async (
          _factory: unknown,
          options?: Record<string, unknown>,
        ) => {
          called = true;
          captured = options;
        },
      },
    };
    await openOverlay(ctx as never, spec(["a"]));
    expect(called).toBe(true);
    // Composer-replacement placement: the host only mounts into the editor
    // container when `overlay` is falsy, so these must stay unset.
    expect(captured?.overlay).toBeUndefined();
    expect(captured?.overlayOptions).toBeUndefined();
  });

  test("the live run summary is muted for exactly as long as the panel is open", async () => {
    const calls: boolean[] = [];
    const widget = { setSuppressed: (value: boolean) => calls.push(value) };
    const ctx = {
      ui: {
        custom: async () => {
          // The panel is mounted at this point: the summary must be muted.
          expect(calls).toEqual([true]);
        },
      },
    };
    await openOverlay(ctx as never, spec(["a"]), widget);
    expect(calls).toEqual([true, false]);
  });

  test("a failing panel still restores the live run summary", async () => {
    const calls: boolean[] = [];
    const widget = { setSuppressed: (value: boolean) => calls.push(value) };
    const ctx = {
      ui: {
        custom: async () => {
          throw new Error("panel exploded");
        },
      },
    };
    await expect(
      openOverlay(ctx as never, spec(["a"]), widget),
    ).rejects.toThrow("panel exploded");
    expect(calls).toEqual([true, false]);
  });

  test("shift+arrows scroll the detail pane, plain arrows move the table", () => {
    const tui = {
      terminal: { rows: 30 },
      requestRender: () => {},
    } as unknown as TUI;
    const detail = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const panel = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a", "b"], () => detail),
      () => {},
    );
    const first = panel.render(60);
    expect(first.some((line) => line.includes("line 0 "))).toBe(true);

    panel.handleInput("\x1b[1;2B"); // shift+down
    const scrolled = panel.render(60);
    expect(scrolled.some((line) => line.includes("line 0 "))).toBe(false);
    expect(scrolled.some((line) => line.includes("1 earlier lines"))).toBe(
      true,
    );

    panel.handleInput("\x04"); // ctrl+d: one pane down
    const paged = panel.render(60);
    expect(paged.some((line) => line.includes("line 20"))).toBe(true);

    panel.handleInput("\x1b[1;2H"); // shift+home: back to the top
    expect(panel.render(60).some((line) => line.includes("line 0 "))).toBe(
      true,
    );

    // Changing rows resets the window, so a fresh pane starts at its top.
    panel.handleInput("\x1b[1;2B");
    panel.handleInput("\x1b[B"); // plain down: table selection
    const other = panel.render(60);
    expect(other.find((line) => line.includes("▸"))).toContain("row b");
    expect(other.some((line) => line.includes("line 0 "))).toBe(true);
    panel.dispose();
  });

  test("a live tail follows the newest line until the user scrolls up", () => {
    const tui = {
      terminal: { rows: 30 },
      requestRender: () => {},
    } as unknown as TUI;
    const detail = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const tailSpec: OverlaySpec<string> = {
      ...spec(["a"], () => detail),
      detailWindow: () => "tail",
    };
    const panel = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      tailSpec,
      () => {},
    );
    expect(panel.render(60).some((line) => line.includes("line 99"))).toBe(
      true,
    );
    panel.handleInput("\x1b[1;2A"); // shift+up
    const scrolled = panel.render(60);
    expect(scrolled.some((line) => line.includes("line 99"))).toBe(false);
    expect(scrolled.some((line) => line.includes("more lines"))).toBe(true);
    panel.handleInput("\x1b[1;2B"); // shift+down re-arms follow mode
    expect(panel.render(60).some((line) => line.includes("line 99"))).toBe(
      true,
    );
    panel.dispose();
  });

  test("composer captures text and submits without closing the overlay", async () => {
    let submitted: string | undefined;
    let closed = false;
    const tui = {
      terminal: { rows: 24 },
      requestRender: () => {},
    } as unknown as TUI;
    const composerSpec: OverlaySpec<string> = {
      ...spec(["a"]),
      onAction: (key) =>
        key === "s"
          ? {
              compose: {
                label: "Steer",
                submit: (value) => {
                  submitted = value;
                },
              },
            }
          : undefined,
    };
    const overlay = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      composerSpec,
      () => {
        closed = true;
      },
    );

    overlay.handleInput("s");
    const composing = overlay.render(60);
    expect(composing.some((line) => line.includes("Steer:"))).toBe(true);
    expect(composing.some((line) => line.includes("Steer: >"))).toBe(false);
    expect(composing.at(-2)).toContain("enter send · esc cancel");
    overlay.handleInput("revise the result");
    overlay.handleInput("\r");
    await Promise.resolve();
    expect(submitted).toBe("revise the result");
    expect(closed).toBe(false);
    expect(overlay.render(60).at(-2)).toContain("hints");
    overlay.dispose();
  });
});

describe("visibleWidgetRuns", () => {
  const run = (id: string, status: RunView["status"]): RunView =>
    ({
      status,
      header: { id, source: { kind: "command" } },
    }) as unknown as RunView;

  test("keeps live runs and drops settled or hidden ones", () => {
    const runs = [
      run("aaa", "running"),
      run("bbb", "running"),
      run("ccc", "completed"),
    ];
    const visible = visibleWidgetRuns(runs, new Set(["bbb"]));
    expect(visible.map((r) => r.header.id)).toEqual(["aaa"]);
  });

  test("no hidden entries keeps all live runs", () => {
    const runs = [run("aaa", "running"), run("bbb", "failed")];
    expect(visibleWidgetRuns(runs, new Set())).toHaveLength(1);
  });
});
