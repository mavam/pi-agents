import { describe, expect, test } from "bun:test";
import type { ProgramStatus, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentInfo, MessageInfo } from "../../src/agents/types.js";
import { EMPTY_USAGE } from "../../src/agents/types.js";
import type { SessionHost } from "../../src/pi/session.js";
import { AgentPanel } from "../../src/ui/panel.js";

const now = 100_000;

function agent(id: string, name: string): AgentInfo {
  return {
    id,
    name,
    job: name,
    cwd: "/repo",
    state: "working",
    closed: false,
    createdAt: now - Number(id) * 1_000,
    stateSince: now,
    lastActivityAt: now,
    usage: { ...EMPTY_USAGE },
    activity: {},
  };
}

/** A panel over fixed agents and messages, mounted like Pi mounts it. */
function mount(
  messages: MessageInfo[] = [],
  agents = [agent("1", "scout"), agent("2", "notes")],
) {
  const service = {
    list: () => agents,
    graphs: () => [],
    agentById: (id: string) => agents.find((each) => each.id === id),
    messages: () => messages,
  };
  const host = {
    current: () => service,
  } as unknown as SessionHost;
  const panel = new AgentPanel(host, () => now);
  const attached: string[] = [];
  panel.onAttach = (id) => attached.push(id);
  // biome-ignore lint/suspicious/noExplicitAny: a minimal widget host.
  let component: any;
  const reports: ProgramStatus[] = [];
  const terminal = {
    rows: 40,
    setProgramStatus: (status: ProgramStatus) => reports.push(status),
  };
  panel.update({
    mode: "tui",
    isIdle: () => true,
    ui: {
      setWidget: (
        _key: string,
        factory: (tui: unknown, theme: unknown) => unknown,
      ) => {
        if (!factory) return;
        component = factory(
          {
            terminal,
            requestRender() {},
            hasOverlay: () => false,
          },
          {
            fg: (_name: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
      },
    },
  } as never);
  const click = (width: number, y: number, x: number) => {
    component.render(width);
    return component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
    } as TuiMouseEvent);
  };
  // Lines start after one column of padding.
  const render = (width: number): string[] =>
    component.render(width).map((line: string) => line.slice(1).trimEnd());
  return { click, attached, panel, render, terminal, reports };
}

describe("panel", () => {
  test("reports working until the last child settles, even with the panel hidden", () => {
    const scout = agent("1", "scout");
    const notes = agent("2", "notes");
    const { panel, terminal, reports } = mount([], [scout, notes]);
    try {
      expect(reports.at(-1)?.state).toBe("working");
      terminal.setProgramStatus({ app: "pi", state: "idle" });
      expect(reports.at(-1)?.state).toBe("working");
      panel.setSuppressed(true);
      scout.state = "idle";
      panel.update();
      expect(reports.at(-1)?.state).toBe("working");
      notes.state = "waiting";
      panel.update();
      expect(reports.at(-1)?.state).toBe("idle");
    } finally {
      panel.dispose();
    }
  });

  test("a click on the summary focuses the panel; on a row, it attaches", () => {
    const message: MessageInfo = {
      id: "m",
      from: { id: "1", name: "scout" },
      to: { id: "2", name: "notes" },
      text: "hello",
      sentAt: now - 3_000,
      status: "queued",
    };
    const { click, attached, panel } = mount([message]);
    expect(click(80, 0, 3)).toEqual({ handled: true });
    expect(panel.isFocused()).toBe(true);
    expect(attached).toEqual([]);
    // Working agents, newest first: scout, then notes.
    click(80, 0, 3);
    click(80, 1, 3);
    // Stacked below the agents, the message attaches to its recipient.
    click(80, 3, 3);
    expect(attached).toEqual(["1", "2", "2"]);
    // In columns, the left part attaches to the agent, the right part to
    // the message's recipient.
    click(140, 1, 2);
    click(140, 0, 100);
    // Nothing attaches past the last message.
    expect(click(140, 1, 100)).toBeUndefined();
    expect(attached.slice(3)).toEqual(["2", "2"]);
    panel.dispose();
  });

  test("unfocused, the panel is a summary line; focused, it shows everything", () => {
    const agents = Array.from({ length: 8 }, (_, index) =>
      agent(String(index + 1), `a${index + 1}`),
    );
    const { panel, render } = mount([], agents);
    expect(render(80)).toEqual(["◉ 8 working · ← agents"]);
    panel.setFocused(true);
    expect(render(80).filter((line) => /◉ a\d/.test(line))).toHaveLength(8);
    panel.dispose();
  });
});
