import { describe, expect, test } from "bun:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { AgentProgramStatus } from "../../src/ui/program-status.js";

function setup(initial: ProgramStatus = { app: "pi", state: "idle" }) {
  const reports: ProgramStatus[] = [];
  const terminal = {
    setProgramStatus(status: ProgramStatus) {
      reports.push(status);
    },
  };
  const original = terminal.setProgramStatus;
  const activity = new AgentProgramStatus();
  activity.attach(terminal, initial);
  return { activity, terminal, original, reports };
}

describe("child-agent terminal status", () => {
  test("keeps a settled parent working until the last child stops", () => {
    const { activity, terminal, reports } = setup();
    activity.setActive(true);
    expect(reports.at(-1)?.state).toBe("working");
    terminal.setProgramStatus({ app: "pi", state: "idle" });
    expect(reports.at(-1)?.state).toBe("working");
    terminal.setProgramStatus({ app: "pi", state: "done", message: "Session" });
    expect(reports.at(-1)?.state).toBe("working");
    activity.setActive(false);
    expect(reports.at(-1)).toEqual({
      app: "pi",
      state: "done",
      message: "Session",
    });
    activity.dispose();
  });

  test("preserves questions, errors, and clear reports while children work", () => {
    const { activity, terminal, reports } = setup();
    activity.setActive(true);
    for (const status of [
      { app: "pi", state: "blocked", kind: "question", message: "Choose" },
      { app: "pi", state: "error", message: "Failed" },
      { state: "clear" },
    ] satisfies ProgramStatus[]) {
      terminal.setProgramStatus(status);
      expect(reports.at(-1)).toEqual(status);
    }
    terminal.setProgramStatus({ app: "pi", state: "idle" });
    expect(reports.at(-1)?.state).toBe("working");
    activity.dispose();
  });

  test("child completion does not clear an open permission dialog", () => {
    const { activity, terminal, reports } = setup();
    activity.setActive(true);
    const blocked: ProgramStatus = {
      app: "pi",
      state: "blocked",
      kind: "permission",
    };
    terminal.setProgramStatus(blocked);
    activity.setActive(false);
    expect(reports.at(-1)).toEqual(blocked);
    terminal.setProgramStatus({ app: "pi", state: "working" });
    expect(reports.at(-1)).toEqual({ app: "pi", state: "working" });
    activity.dispose();
  });

  test("restores the native writer and latest parent status on reload", () => {
    const { activity, terminal, original, reports } = setup();
    activity.setActive(true);
    terminal.setProgramStatus({ app: "pi", state: "idle", message: "Parent" });
    activity.dispose();
    activity.dispose();
    expect(terminal.setProgramStatus).toBe(original);
    expect(reports.at(-1)).toEqual({
      app: "pi",
      state: "idle",
      message: "Parent",
    });
    const count = reports.length;
    activity.setActive(true);
    expect(reports).toHaveLength(count);
  });

  test("supports activity before mounting without reinstalling its writer", () => {
    const activity = new AgentProgramStatus();
    const reports: ProgramStatus[] = [];
    const terminal = {
      setProgramStatus: (status: ProgramStatus) => reports.push(status),
    };
    activity.setActive(true);
    activity.attach(terminal, { app: "pi", state: "idle" });
    const wrapper = terminal.setProgramStatus;
    activity.attach(terminal, { app: "pi", state: "idle" });
    expect(terminal.setProgramStatus).toBe(wrapper);
    expect(reports.at(-1)?.state).toBe("working");
    activity.dispose();
  });

  test("does not overwrite a writer installed by another extension", () => {
    const { activity, terminal, reports } = setup();
    activity.setActive(true);
    const previous = terminal.setProgramStatus;
    const newer = (status: ProgramStatus) => previous(status);
    terminal.setProgramStatus = newer;
    activity.dispose();
    expect(terminal.setProgramStatus).toBe(newer);
    terminal.setProgramStatus({ app: "pi", state: "done" });
    expect(reports.at(-1)?.state).toBe("done");
  });
});
