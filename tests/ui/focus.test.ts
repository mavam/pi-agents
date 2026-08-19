import { describe, expect, test } from "bun:test";
import { isPrintable } from "../../src/ui/focus.js";

describe("isPrintable", () => {
  test("accepts typed text", () => {
    expect(isPrintable("a")).toBe(true);
    expect(isPrintable("Z")).toBe(true);
    expect(isPrintable("\u00fc")).toBe(true);
    expect(isPrintable("/")).toBe(true);
  });

  test("rejects escape sequences and control bytes", () => {
    // Cursor-position report, focus events, and bracketed-paste markers all
    // start with ESC; none of them may steal panel focus.
    expect(isPrintable("\u001b[24;1R")).toBe(false);
    expect(isPrintable("\u001b[I")).toBe(false);
    expect(isPrintable("\u001b[200~")).toBe(false);
    expect(isPrintable("\r")).toBe(false);
    expect(isPrintable("\u0000")).toBe(false);
    expect(isPrintable("\u007f")).toBe(false);
    expect(isPrintable("")).toBe(false);
  });
});
