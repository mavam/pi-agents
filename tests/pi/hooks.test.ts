import { describe, expect, test } from "bun:test";
import {
  createEventBus,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_HOOKS_DISCOVER,
  type AgentHooksDiscovery,
} from "../../src/hooks.js";
import { copyExtensionValue } from "../../src/host/hook-state.js";
import { captureAgentState, discoverAgentHooks } from "../../src/pi/hooks.js";

const spec = { job: "work", cwd: "." };

describe("agent hook discovery and capture", () => {
  test("optional, ordered, synchronous discovery with detached creation state", () => {
    const events = createEventBus();
    expect(discoverAgentHooks(events)).toEqual([]);
    const source = { version: 1, settings: { enabled: true } };
    let late: AgentHooksDiscovery | undefined;
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      late = message as AgentHooksDiscovery;
      late.register({ namespace: "z" });
      late.register({
        namespace: "a",
        onAgentCreate: (ctx) => {
          expect(Object.isFrozen(ctx.spec)).toBe(true);
          expect(ctx.parent.branch.at(-1)?.type).toBe("custom");
          return source;
        },
      });
    });
    const hooks = discoverAgentHooks(events);
    late?.register({ namespace: "late" });
    expect(hooks.map((hook) => hook.namespace)).toEqual(["a", "z"]);
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("settings", { enabled: true });
    const state = captureAgentState(
      hooks,
      { sessionManager: manager } as ExtensionContext,
      spec,
    );
    source.settings.enabled = false;
    expect(state).toEqual({ a: { version: 1, settings: { enabled: true } } });
  });

  test("duplicate registrations and capture errors cannot be swallowed by the bus", () => {
    const events = createEventBus();
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      const discovery = message as AgentHooksDiscovery;
      discovery.register({ namespace: "duplicate" });
      discovery.register({ namespace: "duplicate" });
    });
    expect(() => discoverAgentHooks(events)).toThrow("duplicate");
    const ctx = {
      sessionManager: SessionManager.inMemory(),
    } as ExtensionContext;
    expect(() =>
      captureAgentState(
        [
          {
            namespace: "broken",
            onAgentCreate: () => {
              throw new Error("no");
            },
          },
        ],
        ctx,
        spec,
      ),
    ).toThrow("broken: onAgentCreate failed");
  });

  test("state rejects values JSON would lose or change", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [
      cycle,
      { missing: undefined },
      Infinity,
      new Date(),
      Promise.resolve(1),
      () => 1,
      [undefined],
    ])
      expect(() => copyExtensionValue(value)).toThrow();
    expect(copyExtensionValue({ value: null, array: [1, true, "x"] })).toEqual({
      value: null,
      array: [1, true, "x"],
    });
  });
});
