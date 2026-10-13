import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  AGENTS_STATE_EVENT,
  AGENTS_STATE_REQUEST_EVENT,
  type AgentLifecycleInfo,
  AgentStatePublisher,
  type AgentsStateSnapshot,
} from "../../src/pi/events.js";
import {
  closeService,
  createGatedFaux,
  MODEL,
  openService,
  until,
} from "../agents/helpers.js";

function setup(initial: AgentLifecycleInfo[] = []) {
  const events = createEventBus();
  const snapshots: AgentsStateSnapshot[] = [];
  events.on(AGENTS_STATE_EVENT, (value) => {
    snapshots.push(value as AgentsStateSnapshot);
  });
  let agents = initial;
  const publisher = new AgentStatePublisher(events, () => agents);
  return {
    events,
    snapshots,
    publisher,
    replace: (next: AgentLifecycleInfo[]) => {
      agents = next;
      publisher.update();
    },
  };
}

function agent(
  id: string,
  state: AgentLifecycleInfo["state"] = "working",
  closed = false,
): AgentLifecycleInfo {
  return { id, name: id, state, closed };
}

describe("child-agent lifecycle protocol", () => {
  test("initial state is published only after session restoration", () => {
    const { events, snapshots, publisher } = setup([agent("restored")]);
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    publisher.update();
    expect(snapshots).toEqual([]);
    publisher.start("session");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      protocol: 1,
      sessionId: "session",
      sequence: 1,
      type: "snapshot",
      agents: [agent("restored")],
    });
    expect(snapshots[0]?.instanceId).toBeString();
    publisher.dispose();
  });

  test("late listeners can request the current empty or working state", () => {
    const { events, publisher, replace } = setup();
    publisher.start("session");
    const received: AgentsStateSnapshot[] = [];
    events.on(AGENTS_STATE_EVENT, (value) => {
      received.push(value as AgentsStateSnapshot);
    });
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(received[0]?.agents).toEqual([]);
    replace([agent("worker")]);
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(received.at(-1)?.agents).toEqual([agent("worker")]);
    expect(received.map((snapshot) => snapshot.sequence)).toEqual([2, 3, 4]);
    const count = received.length;
    for (const invalid of [
      null,
      undefined,
      1,
      "1",
      {},
      { protocol: 2 },
      { protocol: "1" },
    ])
      events.emit(AGENTS_STATE_REQUEST_EVENT, invalid);
    expect(received).toHaveLength(count);
    publisher.dispose();
  });

  test("membership and lifecycle changes replace state without double counting", () => {
    const { snapshots, publisher, replace } = setup();
    publisher.start("session");
    replace([agent("b"), agent("a")]);
    expect(snapshots.at(-1)?.agents.map((info) => info.id)).toEqual(["a", "b"]);
    replace([agent("a"), agent("b")]);
    expect(snapshots).toHaveLength(2);
    replace([agent("a", "idle"), agent("b", "working", true)]);
    expect(
      snapshots.at(-1)?.agents.filter((info) => info.state === "working"),
    ).toEqual([agent("b", "working", true)]);
    for (const state of [
      "waiting",
      "failed",
      "interrupted",
      "skipped",
    ] as const) {
      replace([agent("b", state)]);
      expect(snapshots.at(-1)?.agents).toEqual([agent("b", state)]);
    }
    replace([agent("b", "working")]);
    replace([{ ...agent("b"), name: "renamed" }]);
    expect(snapshots.at(-1)?.agents[0]?.name).toBe("renamed");
    replace([]);
    expect(snapshots.at(-1)?.agents).toEqual([]);
    publisher.dispose();
  });

  test("published snapshots are detached, deeply frozen, and omit private fields", () => {
    const info = {
      ...agent("a"),
      job: "private prompt",
      result: { text: "private answer" },
    };
    const { snapshots, publisher } = setup([info]);
    publisher.start("session");
    const snapshot = snapshots[0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.agents)).toBe(true);
    expect(Object.isFrozen(snapshot?.agents[0])).toBe(true);
    info.name = "changed";
    expect(snapshot?.agents).toEqual([agent("a")]);
    publisher.update();
    expect(snapshots.at(-1)?.agents[0]?.name).toBe("changed");
    publisher.dispose();
  });

  test("replacement resets identity and disposal clears ownership exactly once", () => {
    const { events, snapshots, publisher } = setup([agent("a")]);
    publisher.start("old");
    const first = snapshots[0];
    publisher.start("new");
    expect(snapshots[1]).toMatchObject({
      sessionId: "old",
      type: "stopped",
      sequence: 2,
      agents: [],
    });
    expect(snapshots[2]).toMatchObject({
      sessionId: "new",
      type: "snapshot",
      sequence: 1,
    });
    expect(snapshots[2]?.instanceId).not.toBe(first?.instanceId);
    publisher.dispose();
    const count = snapshots.length;
    publisher.dispose();
    publisher.start("ignored");
    publisher.update(true);
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(snapshots).toHaveLength(count);
    expect(snapshots.at(-1)).toMatchObject({
      sessionId: "new",
      type: "stopped",
      agents: [],
    });
    // A new runtime on the same bus must not revive the old listener.
    const next = new AgentStatePublisher(events, () => []);
    next.start("new");
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(snapshots).toHaveLength(count + 2);
    next.dispose();
  });

  test("real service transitions retain activity until the last child ends", async () => {
    const { models, release } = createGatedFaux();
    const service = await openService({ models });
    const events = createEventBus();
    const snapshots: AgentsStateSnapshot[] = [];
    events.on(AGENTS_STATE_EVENT, (value) => {
      snapshots.push(value as AgentsStateSnapshot);
    });
    const publisher = new AgentStatePublisher(events, () => service.list());
    const unsubscribe = service.subscribe(() => publisher.update());
    const working = () =>
      snapshots.at(-1)?.agents.filter((info) => info.state === "working") ?? [];
    try {
      publisher.start("session");
      await service.spawn({ name: "a", job: "hold a", cwd: ".", model: MODEL });
      await service.spawn({ name: "b", job: "hold b", cwd: ".", model: MODEL });
      await until(() => working().length === 2);
      await service.stop("a");
      await until(() => working().length === 1);
      expect(working()[0]?.name).toBe("b");
      release();
      await until(() => working().length === 0);
      expect(
        snapshots.at(-1)?.agents.find((info) => info.name === "b")?.state,
      ).toBe("idle");
    } finally {
      publisher.dispose();
      unsubscribe();
      await closeService(service);
    }
  });
});
