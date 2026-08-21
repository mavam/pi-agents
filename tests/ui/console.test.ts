import { describe, expect, test } from "bun:test";
import { sanitizeLine } from "../../src/ui/console.js";

const ESC = "\u001b";
const BEL = "\u0007";

describe("sanitizeLine", () => {
  test("removes OSC sequences whole instead of stripping their terminator", () => {
    // pi wraps messages in OSC 133 zones; a half-stripped OSC makes the
    // terminal swallow everything after it.
    expect(sanitizeLine(`${ESC}]133;A${BEL}hello`)).toBe("hello");
    expect(sanitizeLine(`tail${ESC}]133;B${BEL}${ESC}]133;C${BEL}done`)).toBe(
      "taildone",
    );
    expect(sanitizeLine(`st${ESC}]0;title${ESC}\\rest`)).toBe("strest");
  });

  test("keeps SGR colors, expands tabs, drops other control bytes", () => {
    expect(sanitizeLine(`${ESC}[7mbadge${ESC}[27m`)).toBe(
      `${ESC}[7mbadge${ESC}[27m`,
    );
    expect(sanitizeLine("a\tb\rc")).toBe("a  bc");
  });
});
