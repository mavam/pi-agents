import { describe, expect, test } from "bun:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentExtension from "../../src/index.js";
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
  tempDir,
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
  test("initial publication waits for start and reads the current agents", () => {
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

  test("real Pi lifecycle clears old publishers in either extension load order", async () => {
    for (const producerFirst of [true, false]) {
      const cwd = tempDir();
      const events = createEventBus();
      const snapshots: AgentsStateSnapshot[] = [];
      events.on(AGENTS_STATE_EVENT, (value) => {
        snapshots.push(value as AgentsStateSnapshot);
      });
      const consumer: ExtensionFactory = (pi) => {
        pi.on("session_start", () => {
          pi.events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
        });
      };
      const runtime = await createAgentSessionRuntime(
        async ({ cwd, sessionManager, sessionStartEvent }) => {
          const services = await createAgentSessionServices({
            cwd,
            settingsManager: SettingsManager.inMemory(),
            resourceLoaderOptions: {
              eventBus: events,
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              extensionFactories: producerFirst
                ? [agentExtension, consumer]
                : [consumer, agentExtension],
            },
          });
          return {
            ...(await createAgentSessionFromServices({
              services,
              sessionManager,
              sessionStartEvent,
              noTools: "all",
            })),
            services,
            diagnostics: services.diagnostics,
          };
        },
        { cwd, sessionManager: SessionManager.inMemory(cwd) },
      );
      try {
        expect(snapshots).toEqual([]);
        const errors: unknown[] = [];
        await runtime.session.bindExtensions({
          mode: "json",
          onError: (error) => errors.push(error),
        });
        // Let the host's deferred startup maintenance run before invalidation.
        await new Promise((resolve) => setImmediate(resolve));
        const first = snapshots[0];
        expect(first).toMatchObject({
          sessionId: runtime.session.sessionManager.getSessionId(),
          sequence: 1,
          type: "snapshot",
          agents: [],
        });
        expect(snapshots).toHaveLength(producerFirst ? 2 : 1);
        const beforeReload = snapshots.length;
        await runtime.session.reload();
        await new Promise((resolve) => setImmediate(resolve));
        expect(errors).toEqual([]);
        expect(snapshots[beforeReload]).toMatchObject({
          instanceId: first?.instanceId,
          type: "stopped",
          agents: [],
        });
        const reloaded = snapshots[beforeReload + 1];
        expect(reloaded).toMatchObject({
          sessionId: first?.sessionId,
          sequence: 1,
          type: "snapshot",
          agents: [],
        });
        expect(reloaded?.instanceId).not.toBe(first?.instanceId);
        expect(
          snapshots.slice(beforeReload).map((snapshot) => snapshot.type),
        ).toEqual(
          producerFirst
            ? ["stopped", "snapshot", "snapshot"]
            : ["stopped", "snapshot"],
        );
        const beforeRequest = snapshots.length;
        events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
        expect(snapshots).toHaveLength(beforeRequest + 1);
        expect(snapshots.at(-1)?.instanceId).toBe(reloaded?.instanceId);
        const beforeReplacement = snapshots.length;
        await runtime.newSession();
        expect(snapshots[beforeReplacement]).toMatchObject({
          instanceId: reloaded?.instanceId,
          type: "stopped",
        });
        await runtime.session.bindExtensions({
          mode: "json",
          onError: (error) => errors.push(error),
        });
        await new Promise((resolve) => setImmediate(resolve));
        const replacement = snapshots[beforeReplacement + 1];
        expect(replacement).toMatchObject({ sequence: 1, type: "snapshot" });
        expect(replacement?.sessionId).not.toBe(first?.sessionId);
        expect(replacement?.instanceId).not.toBe(reloaded?.instanceId);
        expect(
          snapshots.slice(beforeReplacement).map((snapshot) => snapshot.type),
        ).toEqual(
          producerFirst
            ? ["stopped", "snapshot", "snapshot"]
            : ["stopped", "snapshot"],
        );
        const beforeReplacementRequest = snapshots.length;
        events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
        expect(snapshots).toHaveLength(beforeReplacementRequest + 1);
        expect(snapshots.at(-1)?.instanceId).toBe(replacement?.instanceId);
        expect(errors).toEqual([]);
      } finally {
        await runtime.dispose();
      }
      expect(snapshots.at(-1)).toMatchObject({ type: "stopped", agents: [] });
      const afterShutdown = snapshots.length;
      events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
      expect(snapshots).toHaveLength(afterShutdown);
    }
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
