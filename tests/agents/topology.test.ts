import { describe, expect, test } from "bun:test";
import {
  endNodes,
  findCycle,
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

  test("cycles are found with their path", () => {
    expect(findCycle([node("a", "b"), node("b", "a")])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(findCycle([node("a"), node("b", "a")])).toBeUndefined();
  });
});
