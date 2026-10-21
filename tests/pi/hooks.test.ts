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
import { copyExtensionValue, hookError } from "../../src/host/hook-state.js";
import { captureAgentState, discoverAgentHooks } from "../../src/pi/hooks.js";

describe("agent hook discovery and capture", () => {
  test("optional, ordered, synchronous discovery with detached creation state", () => {
    const events = createEventBus();
    expect(discoverAgentHooks(events)).toEqual({ hooks: [], problems: [] });
    const source = { version: 1, settings: { enabled: true } };
    let late: AgentHooksDiscovery | undefined;
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      late = message as AgentHooksDiscovery;
      late.register({ namespace: "z" });
      late.register({
        namespace: "a",
        onAgentCreate: (ctx) => {
          const { branch } = ctx.parent;
          expect(Object.isFrozen(branch.at(-1))).toBe(true);
          expect(ctx.parent.branch).toBe(branch); // Shared, detached once.
          expect(branch.at(-1)?.type).toBe("custom");
          return source;
        },
      });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    late?.register({ namespace: "late" });
    expect(problems).toEqual([]);
    expect(hooks.map((hook) => hook.namespace)).toEqual(["a", "z"]);
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("settings", { enabled: true });
    const state = captureAgentState(hooks, {
      sessionManager: manager,
    } as ExtensionContext);
    source.settings.enabled = false;
    expect(state).toEqual({ a: { version: 1, settings: { enabled: true } } });
    expect(
      Object.isFrozen(manager.getBranch().at(-1)), // Pi's entries stay its own.
    ).toBe(false);
  });

  test("broken registrations are ignored; capture errors still fail creation", () => {
    const events = createEventBus();
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      const discovery = message as AgentHooksDiscovery;
      discovery.register({ namespace: "duplicate" });
      discovery.register({ namespace: "duplicate" });
      discovery.register({ namespace: "not valid" });
      discovery.register({ namespace: "kept" });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    expect(hooks.map((hook) => hook.namespace)).toEqual(["kept"]);
    expect(problems).toEqual([
      'invalid registration "not valid"',
      'duplicate namespace "duplicate"',
    ]);
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
      ),
    ).toThrow("Agent extension broken: onAgentCreate failed: no");
    expect(() =>
      captureAgentState(
        [{ namespace: "big", onAgentCreate: () => "x".repeat(9 * 1024) }],
        ctx,
      ),
    ).toThrow("exceeds 8 KiB");
  });

  test("errors name the hook and keep only a message as detail", () => {
    expect(hookError("ns", "onAgentRequest", { secret: 1 }).message).toBe(
      "Agent extension ns: onAgentRequest failed",
    );
    expect(
      hookError("ns", "onAgentRequest", new Error("bad\nstate")).message,
    ).toBe("Agent extension ns: onAgentRequest failed: bad state");
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
