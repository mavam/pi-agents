import { describe, expect, test } from "bun:test";
import { selectDisplayValue } from "../../src/presentation/result.js";

describe("structured result selection", () => {
  test("selects a nested Markdown display path", () => {
    const value = {
      review: { markdown: "# Code Review" },
      findings: [{ id: "BUG-1" }],
    };

    expect(selectDisplayValue(value, "review.markdown")).toEqual({
      value: "# Code Review",
      selected: true,
    });
  });

  test("selects a conventional top-level report", () => {
    const value = { report: "# Report", findings: [] };
    expect(selectDisplayValue(value, undefined)).toEqual({
      value: "# Report",
      selected: true,
    });
  });

  test("explains missing and non-string display fallbacks", () => {
    const value = { summary: { text: "not directly renderable" } };

    expect(selectDisplayValue(value, "report")).toEqual({
      value,
      selected: false,
      warning: "Display path `report` was not found; showing the raw result.",
    });
    expect(selectDisplayValue(value, "summary")).toEqual({
      value,
      selected: false,
      warning:
        "Display path `summary` resolved to a non-string value; showing the raw result.",
    });
  });
});
