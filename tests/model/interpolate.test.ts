import { describe, expect, test } from "bun:test";
import {
  InterpolationError,
  isSingleReference,
  MAX_INTERPOLATION_CHARS,
  parseTemplate,
  renderTemplate,
  resolvePath,
  stringifyValue,
  templateRefs,
} from "../../src/model/interpolate.js";

describe("parseTemplate", () => {
  test("plain text has no refs", () => {
    expect(parseTemplate("just words")).toEqual([
      { kind: "text", text: "just words" },
    ]);
  });

  test("single reference", () => {
    expect(parseTemplate("{scout}")).toEqual([
      { kind: "ref", root: "scout", path: [], raw: "{scout}" },
    ]);
  });

  test("reference with dot path", () => {
    expect(parseTemplate("{review.findings.0}")).toEqual([
      {
        kind: "ref",
        root: "review",
        path: ["findings", "0"],
        raw: "{review.findings.0}",
      },
    ]);
  });

  test("reference embedded in text", () => {
    expect(parseTemplate("Fix: {previous} now")).toEqual([
      { kind: "text", text: "Fix: " },
      { kind: "ref", root: "previous", path: [], raw: "{previous}" },
      { kind: "text", text: " now" },
    ]);
  });

  test("double braces escape literal braces", () => {
    expect(parseTemplate("{{previous}}")).toEqual([
      { kind: "text", text: "{previous}" },
    ]);
  });

  test("JSON-ish braces pass through literally", () => {
    const template = 'Return JSON like {done: boolean, "n": 3}';
    expect(parseTemplate(template)).toEqual([{ kind: "text", text: template }]);
  });

  test("unclosed brace is literal", () => {
    expect(parseTemplate("open { brace")).toEqual([
      { kind: "text", text: "open { brace" },
    ]);
  });

  test("empty braces are literal", () => {
    expect(parseTemplate("{}")).toEqual([{ kind: "text", text: "{}" }]);
  });

  test("reference grammar rejects leading digits and spaces", () => {
    expect(templateRefs("{1abc} { spaced }")).toEqual([]);
  });

  test("multiple references", () => {
    expect(templateRefs("{a} and {b.c}").map((ref) => ref.raw)).toEqual([
      "{a}",
      "{b.c}",
    ]);
  });
});

describe("isSingleReference", () => {
  test("accepts a lone reference", () => {
    expect(isSingleReference("{files}")).toBe(true);
    expect(isSingleReference("{scout.files}")).toBe(true);
  });

  test("rejects text around the reference", () => {
    expect(isSingleReference(" {files}")).toBe(false);
    expect(isSingleReference("{files} extra")).toBe(false);
    expect(isSingleReference("plain")).toBe(false);
    expect(isSingleReference("{a}{b}")).toBe(false);
  });
});

describe("resolvePath", () => {
  test("navigates objects and arrays", () => {
    const value = { review: { findings: ["a", "b"] } };
    expect(resolvePath(value, ["review", "findings", "1"])).toEqual({
      found: true,
      value: "b",
    });
  });

  test("empty path returns the value itself", () => {
    expect(resolvePath(42, [])).toEqual({ found: true, value: 42 });
  });

  test("missing key is not found", () => {
    expect(resolvePath({ a: 1 }, ["b"])).toEqual({ found: false });
  });

  test("non-numeric segment into an array is not found", () => {
    expect(resolvePath([1, 2], ["x"])).toEqual({ found: false });
  });

  test("cannot traverse into primitives", () => {
    expect(resolvePath("text", ["length"])).toEqual({ found: false });
  });
});

describe("stringifyValue", () => {
  test("strings pass through", () => {
    expect(stringifyValue("hello")).toBe("hello");
  });

  test("null and undefined render empty", () => {
    expect(stringifyValue(null)).toBe("");
    expect(stringifyValue(undefined)).toBe("");
  });

  test("objects render as pretty JSON", () => {
    expect(stringifyValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("oversized values are truncated with a marker", () => {
    const big = "x".repeat(MAX_INTERPOLATION_CHARS + 100);
    const result = stringifyValue(big);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain("[truncated 100 characters]");
  });
});

describe("renderTemplate", () => {
  const env: Record<string, unknown> = {
    scout: { files: ["a.ts", "b.ts"], summary: "two files" },
    previous: "prior result",
  };
  const resolve = (root: string) =>
    root in env ? { found: true, value: env[root] } : { found: false };

  test("substitutes references", () => {
    expect(renderTemplate("Use {scout.summary} and {previous}", resolve)).toBe(
      "Use two files and prior result",
    );
  });

  test("renders JSON values", () => {
    expect(renderTemplate("{scout.files}", resolve)).toBe(
      '[\n  "a.ts",\n  "b.ts"\n]',
    );
  });

  test("unknown root throws", () => {
    expect(() => renderTemplate("{nope}", resolve)).toThrow(InterpolationError);
  });

  test("missing path throws with context", () => {
    expect(() => renderTemplate("{scout.missing}", resolve)).toThrow(
      "path 'missing' not found",
    );
  });

  test("undefined root value renders empty, even with a path", () => {
    const last = (root: string) =>
      root === "last" ? { found: true, value: undefined } : { found: false };
    expect(renderTemplate("[{last}]", last)).toBe("[]");
    expect(renderTemplate("[{last.score}]", last)).toBe("[]");
  });

  test("escapes survive rendering", () => {
    expect(renderTemplate("{{previous}} is literal", resolve)).toBe(
      "{previous} is literal",
    );
  });
});
