import { describe, expect, test } from "bun:test";
import type { Predicate } from "../../src/model/ast.js";
import {
  evaluatePredicate,
  formatPredicate,
} from "../../src/model/predicate.js";

const value = {
  done: true,
  score: 7,
  summary: "",
  findings: [],
  meta: { owner: null, tags: ["x"] },
};

const cases: Array<[string, Predicate, unknown, boolean]> = [
  ["eq matches", { eq: ["done", true] }, value, true],
  ["eq mismatched value", { eq: ["done", false] }, value, false],
  ["eq missing path", { eq: ["nope", true] }, value, false],
  ["eq on nested path", { eq: ["meta.owner", null] }, value, true],
  ["eq never matches objects", { eq: ["meta", null] }, value, false],
  ["ne mismatched value", { ne: ["done", false] }, value, true],
  ["ne missing path is true", { ne: ["nope", 1] }, value, true],
  ["gt", { gt: ["score", 5] }, value, true],
  ["gt equal is false", { gt: ["score", 7] }, value, false],
  ["gt non-number is false", { gt: ["summary", 0] }, value, false],
  ["gt missing path is false", { gt: ["nope", 0] }, value, false],
  ["lt", { lt: ["score", 10] }, value, true],
  ["exists present", { exists: "meta.tags" }, value, true],
  ["exists null counts as existing", { exists: "meta.owner" }, value, true],
  ["exists missing", { exists: "meta.nope" }, value, false],
  ["empty string", { empty: "summary" }, value, true],
  ["empty array", { empty: "findings" }, value, true],
  ["empty missing path", { empty: "nope" }, value, true],
  ["empty null", { empty: "meta.owner" }, value, true],
  ["empty non-empty array", { empty: "meta.tags" }, value, false],
  ["empty number is not empty", { empty: "score" }, value, false],
  ["empty object", { empty: "" }, {}, true],
  ["root path addresses whole value", { eq: ["", "ok"] }, "ok", true],
  [
    "and all true",
    { and: [{ eq: ["done", true] }, { gt: ["score", 5] }] },
    value,
    true,
  ],
  [
    "and one false",
    { and: [{ eq: ["done", true] }, { gt: ["score", 100] }] },
    value,
    false,
  ],
  [
    "or one true",
    { or: [{ eq: ["done", false] }, { gt: ["score", 5] }] },
    value,
    true,
  ],
  [
    "or all false",
    { or: [{ eq: ["done", false] }, { gt: ["score", 100] }] },
    value,
    false,
  ],
  ["not", { not: { eq: ["done", true] } }, value, false],
  [
    "nested composition",
    {
      and: [
        { not: { empty: "meta.tags" } },
        { or: [{ eq: ["done", true] }, { exists: "nope" }] },
      ],
    },
    value,
    true,
  ],
];

describe("evaluatePredicate", () => {
  for (const [name, predicate, input, expected] of cases) {
    test(name, () => {
      expect(evaluatePredicate(predicate, input)).toBe(expected);
    });
  }
});

describe("formatPredicate", () => {
  test("renders leaves and composition", () => {
    const predicate: Predicate = {
      and: [{ eq: ["done", true] }, { not: { empty: "findings" } }],
    };
    expect(formatPredicate(predicate)).toBe(
      "(done == true && !empty(findings))",
    );
  });

  test("root path renders as dot", () => {
    expect(formatPredicate({ empty: "" })).toBe("empty(.)");
  });
});
