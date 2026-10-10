import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type AgentInfo,
  EMPTY_USAGE,
  type GraphInfo,
  type GraphNode,
} from "../../src/agents/types.js";
import {
  agentDetail,
  agentHeader,
  graphDetail,
} from "../../src/pi/commands.js";
import { plainColorize } from "../../src/ui/format.js";
import {
  type DetailLine,
  paneLayout,
  renderDetail,
} from "../../src/ui/overlay.js";

beforeAll(() => initTheme("dark"));

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "1",
    name: "a",
    task: "review a",
    cwd: "/repo",
    model: { provider: "openai", modelId: "sol" },
    state: "idle",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE, input: 2_000 },
    activity: {},
    ...overrides,
  };
}

const answered = (agentId: string, name: string, text: string) => ({
  kind: "answered" as const,
  result: { agentId, name, entryId: 1, text, stopReason: "stop" },
});

function graph(nodes: GraphNode[], overrides: Partial<GraphInfo> = {}) {
  return {
    id: "10",
    name: "lead.helpers",
    policy: "allSettled",
    state: "idle",
    closed: false,
    stopped: false,
    createdAt: 0,
    stateSince: 0,
    nodes,
    usage: { ...EMPTY_USAGE },
    ...overrides,
  } satisfies GraphInfo;
}

/** The detail as plain text, at a width of 60; dividers as `├─ label`. */
function plain(lines: DetailLine[]): string[] {
  return renderDetail(lines, 60, plainColorize, getMarkdownTheme()).map(
    (line) =>
      stripVTControlCharacters(
        "divider" in line ? `├─ ${line.divider}` : line.text,
      ),
  );
}

describe("/agents detail", () => {
  const agents = new Map<string, AgentInfo>([
    ["0", agent({ id: "0", name: "lead" })],
    ["1", agent({ id: "1", name: "lead.a" })],
    ["2", agent({ id: "2", name: "lead.b" })],
    ["3", agent({ id: "3", name: "lead.c" })],
  ]);
  const lookup = (id: string) => agents.get(id);

  test("results render as Markdown under each agent's heading", () => {
    const lines = plain(
      graphDetail(
        graph(
          [
            {
              agentId: "1",
              name: "lead.a",
              inputs: [],
              end: true,
              outcome: answered(
                "1",
                "lead.a",
                "- **High:** `x` breaks.\n  **Fix:** guard it.",
              ),
            },
            {
              agentId: "2",
              name: "lead.b",
              inputs: [],
              end: true,
              outcome: { kind: "failed", reason: "rate limited" },
            },
            {
              agentId: "3",
              name: "lead.c",
              inputs: [],
              end: true,
              outcome: { kind: "stopped" },
            },
          ],
          { owner: "0" },
        ),
        lookup,
        plainColorize,
      ),
    );
    expect(lines).toEqual([
      "● a · sol · 2.0k",
      "  - High: x breaks.",
      "    Fix: guard it.",
      "",
      "✗ b · sol · 2.0k",
      "  rate limited",
      "",
      "⊘ c · sol · 2.0k · stopped",
    ]);
  });

  test("a graph whose result waits for Pi says so", () => {
    const lines = plain(
      graphDetail(
        graph(
          [
            {
              agentId: "1",
              name: "lead.a",
              inputs: [],
              end: true,
              outcome: { kind: "failed", reason: "rate limited" },
            },
          ],
          { state: "failed", queued: true },
        ),
        lookup,
        plainColorize,
      ),
    );
    expect(lines).toEqual([
      "The result waits until Pi's turn ends.",
      "",
      "✗ lead.a · sol · 2.0k",
      "  rate limited",
    ]);
  });

  test("a graph with edges says its order without the owner's name", () => {
    const lines = plain(
      graphDetail(
        graph(
          [
            { agentId: "1", name: "lead.a", inputs: [], end: false },
            { agentId: "2", name: "lead.b", inputs: ["1"], end: true },
          ],
          { owner: "0", state: "working" },
        ),
        lookup,
        plainColorize,
      ),
    );
    expect(lines.slice(0, 2)).toEqual(["Runs a, then b.", ""]);
    expect(lines[4]).toBe("● b ← a · sol · 2.0k");
  });

  test("long results end in a line that says how to read the rest", () => {
    const text = Array.from({ length: 20 }, (_, i) => `- point ${i}`).join(
      "\n",
    );
    const lines = plain(
      graphDetail(
        graph([
          {
            agentId: "1",
            name: "lead.a",
            inputs: [],
            end: true,
            outcome: answered("1", "lead.a", text),
          },
        ]),
        lookup,
        plainColorize,
      ),
    );
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe("  … 12 more lines · select lead.a to read all");
  });

  test("a divider separates an agent's task from its result", () => {
    const at = 60_000;
    const done = { ...answered("1", "a", "**done**").result, at: 0 };
    expect(
      stripVTControlCharacters(
        agentHeader(agent({ cwd: `${os.homedir()}/repo` }), plainColorize, at),
      ),
    ).toBe("Task · a · started 1m00s ago · ~/repo");
    // The task renders as Markdown; the answer to it is its result.
    expect(
      plain(
        agentDetail(
          agent({
            task: "Review **a**:\n\n- read `a.ts`",
            result: done,
            taskAnswer: done.entryId,
          }),
          plainColorize,
          at,
        ),
      ),
    ).toEqual([
      "Review a:",
      "",
      "- read a.ts",
      "├─ Result · 1m00s ago",
      "done",
    ]);
    // An answer to a later message is the latest result.
    expect(
      plain(
        agentDetail(
          agent({ result: { ...done, entryId: 7 }, taskAnswer: done.entryId }),
          plainColorize,
          at,
        ),
      ),
    ).toEqual(["review a", "├─ Latest result · 1m00s ago", "done"]);
    // An answer that waits for Pi says so.
    expect(
      plain(
        agentDetail(
          agent({ result: done, taskAnswer: done.entryId, queued: true }),
          plainColorize,
          at,
        ),
      ),
    ).toEqual(["review a", "├─ Result · 1m00s ago · result queued", "done"]);
    expect(
      plain(
        agentDetail(
          agent({
            state: "failed",
            result: { ...done, stopReason: "error", errorMessage: "boom" },
          }),
          plainColorize,
          at,
        ),
      ),
    ).toEqual(["review a", "├─ Error", "boom"]);
  });
});

describe("/agents layout", () => {
  test("the table gets up to half the overlay, not ten rows", () => {
    // A 60-row terminal: the overlay takes 48 rows, 44 without its borders.
    expect(paneLayout(60, 75)).toEqual({ tableRows: 22, detailRows: 22 });
    expect(paneLayout(60, 3)).toEqual({ tableRows: 3, detailRows: 41 });
    expect(paneLayout(12, 75)).toEqual({ tableRows: 2, detailRows: 2 });
  });
});
