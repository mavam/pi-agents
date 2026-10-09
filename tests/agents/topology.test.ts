import { describe, expect, test } from "bun:test";
import {
  endNodes,
  findCycle,
  orderSentence,
  shapeLine,
  stages,
} from "../../src/agents/topology.js";

const node = (key: string, ...inputs: string[]) => ({ key, inputs });

describe("topology", () => {
  test("stages follow inputs and keep node order", () => {
    const diamond = [
      node("merge", "api", "tests"),
      node("api", "map"),
      node("tests", "map"),
      node("map"),
    ];
    expect(stages(diamond)).toEqual([["map"], ["api", "tests"], ["merge"]]);
    expect(shapeLine(diamond)).toBe("map → {api, tests} → merge");
    expect(endNodes(diamond)).toEqual(["merge"]);
  });

  test("a graph without edges is one stage of end nodes", () => {
    const flat = [node("a"), node("b")];
    expect(shapeLine(flat)).toBe("{a, b}");
    expect(endNodes(flat)).toEqual(["a", "b"]);
  });

  test("the order reads as a sentence", () => {
    expect(
      orderSentence([
        node("plan"),
        node("build", "plan"),
        node("review", "build"),
      ]),
    ).toBe("Runs plan, then build, then review.");
    expect(
      orderSentence([
        node("map"),
        node("api", "map"),
        node("tests", "map"),
        node("merge", "api", "tests"),
      ]),
    ).toBe("Runs map, then api and tests at once, then merge.");
    expect(
      orderSentence(
        [
          node("x.a"),
          node("x.b"),
          node("x.c"),
          node("x.m", "x.a", "x.b", "x.c"),
        ],
        (key) => key.slice(2),
      ),
    ).toBe("Runs a, b, and c at once, then m.");
    expect(orderSentence([node("a"), node("b")])).toBeUndefined();
  });

  test("cycles are found with their path", () => {
    expect(findCycle([node("a", "b"), node("b", "a")])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(findCycle([node("a"), node("b", "a")])).toBeUndefined();
  });
});
