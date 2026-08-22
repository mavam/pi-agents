import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandSavedWorkflow } from "../../src/catalog/workflows.js";
import { prepareLaunch } from "../../src/run/launch.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "pi-agents-launch-"));
  mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".pi", "workflows", "greet.yaml"),
    [
      "name: greet",
      "description: Greet a target",
      "display: report",
      "params:",
      "  - name: target",
      "    required: true",
      'flow: { kind: agent, task: "greet {params.target}" }',
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("prepareLaunch", () => {
  test("requires exactly one of flow and workflow", () => {
    expect(() => prepareLaunch({ cwd, trusted: true })).toThrow("exactly one");
    expect(() =>
      prepareLaunch({
        cwd,
        trusted: true,
        flow: { kind: "agent", task: "x" },
        workflow: "greet",
      }),
    ).toThrow("exactly one");
  });

  test("fatal: unknown workflow, untrusted project scope, invalid flow", () => {
    expect(() =>
      prepareLaunch({ cwd, trusted: true, workflow: "nope" }),
    ).toThrow("unknown workflow 'nope'");
    expect(() =>
      prepareLaunch({
        cwd,
        trusted: false,
        scope: "project",
        flow: { kind: "agent", task: "x" },
      }),
    ).toThrow("not trusted");
    expect(() =>
      prepareLaunch({ cwd, trusted: true, flow: { kind: "bogus" } }),
    ).toThrow();
  });

  test("recoverable: invalid display degrades to a warning", () => {
    const plan = prepareLaunch({
      cwd,
      trusted: true,
      flow: { kind: "agent", task: "x" },
      display: "not a path",
    });
    expect(plan.display).toBeUndefined();
    expect(plan.warnings[0]).toContain("Ignored invalid 'display'");
  });

  test("recoverable: params without a saved workflow are ignored", () => {
    const plan = prepareLaunch({
      cwd,
      trusted: true,
      flow: { kind: "agent", task: "x" },
      params: { target: "world" },
    });
    expect(plan.warnings[0]).toContain("Ignored 'params'");
  });

  test("recoverable: invalid labels are ignored and saved defaults apply", () => {
    const inline = prepareLaunch({
      cwd,
      trusted: true,
      flow: { kind: "agent", task: "x" },
      label: "   ",
    });
    expect(inline.label).toBeUndefined();
    expect(inline.warnings[0]).toContain("Ignored invalid 'label'");

    const saved = prepareLaunch({
      cwd,
      trusted: true,
      workflow: "greet",
      params: { target: "world" },
      label: 42,
    });
    expect(saved.label).toBe("greet");
    expect(saved.warnings[0]).toContain("Ignored invalid 'label'");
  });

  test("rejects invalid budgets during preparation", () => {
    expect(() =>
      prepareLaunch({
        cwd,
        trusted: true,
        flow: { kind: "value", value: null },
        budgets: { maxAgents: -1 },
      }),
    ).toThrow("budget 'maxAgents'");
  });

  test("saved workflow supplies label and display defaults", () => {
    const plan = prepareLaunch({
      cwd,
      trusted: true,
      workflow: "greet",
      params: { target: "world" },
    });
    expect(plan.workflowName).toBe("greet");
    expect(plan.label).toBe("greet");
    expect(plan.display).toBe("report");
    expect(plan.warnings).toEqual([]);
    expect(plan.flow.kind).toBe("workflow");
  });

  test("request display overrides the saved workflow's display", () => {
    const plan = prepareLaunch({
      cwd,
      trusted: true,
      workflow: "greet",
      params: { target: "world" },
      display: "summary",
    });
    expect(plan.display).toBe("summary");
  });

  test("untrusted requests clamp discovery to user scope", () => {
    expect(() =>
      prepareLaunch({ cwd, trusted: false, workflow: "greet" }),
    ).toThrow("unknown workflow 'greet'");
  });

  test("accepts a stringified inline flow", () => {
    const plan = prepareLaunch({
      cwd,
      trusted: true,
      flow: JSON.stringify({ kind: "agent", task: "x" }),
    });
    expect(plan.flow.kind).toBe("agent");
  });
});

describe("expandSavedWorkflow", () => {
  test("expands a saved workflow and hides failures", () => {
    expect(expandSavedWorkflow("greet", cwd)?.flow.kind).toBe("agent");
    expect(expandSavedWorkflow("nope", cwd)).toBeUndefined();
  });
});
