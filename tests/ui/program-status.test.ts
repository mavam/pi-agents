import { describe, expect, test } from "bun:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { AgentProgramStatus } from "../../src/ui/program-status.js";

function setup() {
  const reports: ProgramStatus[] = [];
  const terminal = {
    setProgramStatus(status: ProgramStatus) {
      reports.push(status);
    },
  };
  const original = terminal.setProgramStatus;
  const activity = new AgentProgramStatus();
  activity.attach(terminal, { app: "pi", state: "idle" });
  return { activity, terminal, original, reports };
}

describe("child-agent terminal status", () => {
  test("questions, permissions, errors, and clearing take priority over children", () => {
    const { activity, terminal, reports } = setup();
    activity.setActive(true);
    for (const status of [
      { app: "pi", state: "blocked", kind: "question", message: "Choose" },
      { app: "pi", state: "error", message: "Failed" },
      { state: "clear" },
      { app: "pi", state: "blocked", kind: "permission" },
    ] satisfies ProgramStatus[]) {
      terminal.setProgramStatus(status);
      expect(reports.at(-1)).toEqual(status);
    }
    const count = reports.length;
    activity.setActive(false);
    expect(reports).toHaveLength(count);
    activity.dispose();
  });

  test("restores the native writer and latest parent status on reload", () => {
    const { activity, terminal, original, reports } = setup();
    activity.setActive(true);
    terminal.setProgramStatus({ app: "pi", state: "idle", message: "Parent" });
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
