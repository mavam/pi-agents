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
import {
  AGENT_HOOKS_DISCOVER,
  type AgentHooksDiscovery,
} from "../../src/hooks.js";
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
  test("publishes after start, on lifecycle changes, and on request", () => {
    const { events, snapshots, publisher, replace } = setup([agent("b")]);
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(snapshots).toEqual([]);
    publisher.start("session");
    expect(snapshots[0]).toMatchObject({
      protocol: 1,
      sessionId: "session",
      sequence: 1,
      type: "snapshot",
      agents: [agent("b")],
    });
    replace([agent("b"), agent("a")]);
    replace([agent("a"), agent("b")]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.agents.map((info) => info.id)).toEqual(["a", "b"]);
    replace([agent("a", "idle"), agent("b", "waiting")]);
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 2 });
    events.emit(AGENTS_STATE_REQUEST_EVENT, { protocol: 1 });
    expect(snapshots.map((snapshot) => snapshot.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(snapshots.at(-1)?.agents).toEqual([
      agent("a", "idle"),
      agent("b", "waiting"),
    ]);
    publisher.dispose();
    expect(snapshots.at(-1)).toMatchObject({ type: "stopped", agents: [] });
  });

  test("snapshots are frozen and expose only lifecycle fields", () => {
    const info = { ...agent("a"), job: "private prompt" };
    const { snapshots, publisher } = setup([info]);
    publisher.start("session");
    const snapshot = snapshots[0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.agents[0])).toBe(true);
    expect(snapshot?.agents).toEqual([agent("a")]);
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
      let discoveries = 0;
      const consumer: ExtensionFactory = (pi) => {
        pi.events.on(AGENT_HOOKS_DISCOVER, (message) => {
          discoveries++;
          (message as AgentHooksDiscovery).register({
            namespace: "test.lifecycle",
            onAgentCreate: () => ({ version: 1 }),
          });
        });
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
        expect(discoveries).toBe(1);
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
        expect(discoveries).toBe(3); // Initial load, reload, and new session.
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
