import { describe, expect, test } from "bun:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
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
    messaging: () => true,
    panelRows: () => undefined,
  } as unknown as SessionHost;
  const panel = new AgentPanel(host, () => now);
  const attached: string[] = [];
  panel.onAttach = (id) => attached.push(id);
  // biome-ignore lint/suspicious/noExplicitAny: a minimal widget host.
  let component: any;
  panel.update({
    mode: "tui",
    ui: {
      setWidget: (
        _key: string,
        factory: (tui: unknown, theme: unknown) => unknown,
      ) => {
        if (!factory) return;
        component = factory(
          {
            terminal: { rows: 40 },
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
  return { click, attached, panel, render };
}

describe("panel", () => {
  test("a click on a row attaches to its agent, on a message to its recipient", () => {
    const message: MessageInfo = {
      id: "m",
      from: { id: "1", name: "scout" },
      to: { id: "2", name: "notes" },
      text: "hello",
      sentAt: now - 3_000,
      status: "queued",
    };
    const { click, attached, panel } = mount([message]);
    // Working agents, newest first: scout, then notes.
    expect(click(80, 0, 3)).toEqual({ handled: true });
    expect(click(80, 1, 3)).toEqual({ handled: true });
    // Stacked below the agents, the message attaches to its recipient.
    expect(click(80, 3, 3)).toEqual({ handled: true });
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

  test("a digit sets the height: 1 is a summary line, 0 hides until an agent starts", () => {
    const agents = Array.from({ length: 8 }, (_, index) =>
      agent(String(index + 1), `a${index + 1}`),
    );
    const { panel, render } = mount([], agents);
    // By default, five agents and how many more there are.
    expect(render(80)).toHaveLength(6);
    expect(render(80).at(-1)).toBe("+3 more · ← agents");
    panel.setRows(3);
    expect(render(80)).toEqual([
      expect.stringContaining("a1"),
      expect.stringContaining("a2"),
      "+6 more · ← agents",
    ]);
    panel.setRows(1);
    expect(render(80)).toEqual(["◉ 8 working · ← agents"]);
    panel.setRows(0);
    expect(render(80)).toEqual([]);
    // A new agent brings the panel back at the height it had.
    agents.push(agent("9", "a9"));
    expect(render(80)).toEqual(["◉ 9 working · ← agents"]);
    panel.dispose();
  });
});
