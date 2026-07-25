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
    expect(lines.at(-1)).toContain("hints");
    expect(lines.at(-1)?.endsWith("╯")).toBe(true);
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

  test("detail pane pads to the floor so rows above never shift", () => {
    // 1 table row + 1 detail line, but a floor of 8 detail rows:
    // top border + table + separator + 8 detail rows + bottom border.
    const lines = renderOverlay(spec(["a"]), ["a"], 0, 60, 20, undefined, 8);
    expect(lines).toHaveLength(12);
    expect(lines.some((line) => line.includes("detail of a"))).toBe(true);
    // The floor never exceeds the height budget.
    const capped = renderOverlay(spec(["a"]), ["a"], 0, 60, 10, undefined, 99);
    expect(capped.length).toBeLessThanOrEqual(10);
  });

  test("empty list renders the empty text", () => {
    const lines = renderOverlay(spec([]), [], 0, 40, 20);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Nothing here.");
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
    expect(lines.at(-1)).toContain("keys A");
    const empty = renderOverlay(dynamic, [], 0, 50, 20);
    expect(empty[1]).toContain("empty A");
  });

  test("reserves a composer row and replaces the footer hints", () => {
    const lines = renderOverlay(
      spec(["a"]),
      ["a"],
      0,
      60,
      14,
      undefined,
      0,
      ["Steer: revise the result"],
      "enter send · esc cancel",
    );
    expect(
      lines.some((line) => line.includes("Steer: revise the result")),
    ).toBe(true);
    expect(lines.at(-1)).toContain("enter send · esc cancel");
    expect(lines.length).toBeLessThanOrEqual(14);
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
    expect(small.render(60)).toHaveLength(6);
    small.dispose();

    const big = new SplitPaneOverlay(
      tui,
      (_color, text) => text,
      spec(["a"], () => Array.from({ length: 100 }, (_, i) => `line ${i}`)),
      () => {},
    );
    const lines = big.render(60);
    // Fills the whole budget (rows - 4) — no line pi-tui would slice off.
    expect(lines).toHaveLength(46);
    expect(lines.at(-1)).toContain("hints");
    expect(lines.some((line) => line.includes("more lines"))).toBe(true);
    big.dispose();
  });

  test("openOverlay sets no maxHeight — the component owns its height", async () => {
    let captured: { overlayOptions?: Record<string, unknown> } | undefined;
    const ctx = {
      ui: {
        custom: async (
          _factory: unknown,
          options: { overlayOptions?: Record<string, unknown> },
        ) => {
          captured = options;
        },
      },
    };
    await openOverlay(ctx as never, spec(["a"]));
    expect(captured?.overlayOptions?.maxHeight).toBeUndefined();
    expect(captured?.overlayOptions?.row).toBe(2);
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
    expect(composing.at(-1)).toContain("enter send · esc cancel");
    overlay.handleInput("revise the result");
    overlay.handleInput("\r");
    await Promise.resolve();
    expect(submitted).toBe("revise the result");
    expect(closed).toBe(false);
    expect(overlay.render(60).at(-1)).toContain("hints");
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
