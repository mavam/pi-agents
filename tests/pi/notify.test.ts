import { describe, expect, test } from "bun:test";
import type { AgentInfo, GraphInfo } from "../../src/agents/types.js";
import { leaveNotice, pausedNotice, takeNotice } from "../../src/pi/notify.js";
import { tempDir } from "../agents/helpers.js";

const agent = (info: Partial<AgentInfo>) =>
  ({ name: "a", state: "idle", ...info }) as AgentInfo;
const graph = (info: Partial<GraphInfo>) =>
  ({ id: "g", name: "g", state: "idle", ...info }) as GraphInfo;

describe("paused notice", () => {
  test("names working and queued work, not idle agents or helpers", () => {
    expect(pausedNotice([agent({})], [])).toBeUndefined();
    expect(
      pausedNotice(
        [
          agent({ name: "reviewer", state: "working" }),
          agent({ name: "notes", queued: true }),
          agent({ name: "lead.a", state: "working", graph: "h" }),
        ],
        [
          graph({ id: "h", owner: "lead", state: "working" }),
          graph({ name: "review", queued: true }),
        ],
      ),
    ).toBe(
      "pi-agents: reviewer, notes, review are paused with the previous session. Resume that session to continue them and receive results.",
    );
  });

  test("the next session takes the notice once", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir();
    try {
      leaveNotice("/sessions/next.jsonl", "paused");
      expect(takeNotice("/sessions/other.jsonl")).toBeUndefined();
      expect(takeNotice("/sessions/next.jsonl")).toBe("paused");
      expect(takeNotice("/sessions/next.jsonl")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
