import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Storage } from "@earendil-works/pi-durable";
import { lockHolder } from "../../src/host/lock.js";
import { openStorage } from "../../src/host/storage.js";
import { SessionHost } from "../../src/pi/session.js";
import {
  createFaux,
  MODEL,
  TestParent,
  tempDir,
  until,
} from "../agents/helpers.js";

let hosts: SessionHost[] = [];

afterEach(async () => {
  for (const host of hosts) await host.stop();
  hosts = [];
});

let sessions = 0;

/**
 * A host over storage whose next call after `fail()` throws, as a full disk
 * would, in a persistent session unless `memory`. `onNote` sees the host's
 * notifications as they happen.
 */
function failingHost(
  options: { memory?: boolean; onNote?: (text: string) => void } = {},
) {
  const { models } = createFaux();
  let failNext = false;
  const failing = (storage: Storage): Storage =>
    new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (failNext && key !== "close") {
            failNext = false;
            throw new Error("disk full");
          }
          return value.apply(target, args);
        };
      },
    });
  const notes: string[] = [];
  const cwd = tempDir();
  const sessionId = `failing-${++sessions}`;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (text: string) => {
        notes.push(text);
        options.onNote?.(text);
      },
    },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () =>
        options.memory ? undefined : path.join(cwd, "session.jsonl"),
      getEntries: () => [],
    },
    modelRegistry: { runtime: models, getAvailable: () => [] },
  } as unknown as ExtensionContext;
  const host = new SessionHost(new TestParent(), {
    openStorage: async (directory) => failing(await openStorage(directory)),
  });
  hosts.push(host);
  const directory = path.join(
    getAgentDir(),
    "pi-agents",
    "sessions",
    sessionId,
  );
  /** Fail the next storage call; a spawn makes one. */
  const fail = async () => {
    const service = host.current();
    failNext = true;
    await expect(
      service?.spawn({ job: "lost", name: "x", cwd, model: MODEL }) ??
        Promise.reject(new Error("no service")),
    ).rejects.toThrow();
  };
  return { host, ctx, cwd, notes, directory, fail };
}

describe("storage failures", () => {
  test("pause agents and reopen their storage", async () => {
    const { host, ctx, cwd, notes, fail } = failingHost();
    await host.start(ctx);
    const first = await host.ensure(ctx);
    await first.spawn({ job: "one", name: "w", cwd, model: MODEL });
    await first.wait(["w"]);

    await fail();
    await until(() => ![undefined, first].includes(host.current()));
    expect(notes).toContain(
      "pi-agents: Agent storage failed (disk full); reopening it, and agents continue",
    );
    const second = host.current();
    expect(second?.get("w")?.state).toBe("idle");
    await second?.spawn({ job: "three", name: "u", cwd, model: MODEL });
    expect((await second?.wait(["u"]))?.agents[0]?.result?.text).toBe(
      "done: three",
    );
  });

  test("reopening waits for the previous close and keeps its lock", async () => {
    // A recovery closes the failed harness while the parent may already use
    // agents again: the same close, then open.
    const { host, ctx, directory } = failingHost();
    await host.start(ctx);
    await host.ensure(ctx);
    const closing = host.stop();
    const reopened = await host.ensure(ctx);
    await closing;
    expect(host.current()).toBe(reopened);
    expect(lockHolder(directory)).toBe(process.pid);
  });

  test("a shutdown during recovery leaves agents paused", async () => {
    // Pi shuts the session down as the recovery announces the reopen.
    let stopping: Promise<void> | undefined;
    const { host, ctx, directory, fail } = failingHost({
      onNote: (text) => {
        if (text.includes("reopening")) stopping = host.stop();
      },
    });
    await host.start(ctx);
    await host.ensure(ctx);
    await fail();
    await until(() => stopping !== undefined);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.current()).toBeUndefined();
    expect(lockHolder(directory)).toBeUndefined();
  });

  test("a second failure within a minute waits for the next use", async () => {
    const { host, ctx, notes, fail } = failingHost();
    await host.start(ctx);
    const first = await host.ensure(ctx);
    await fail();
    await until(() => ![undefined, first].includes(host.current()));
    await fail();
    await until(() =>
      notes.includes(
        "pi-agents: Agent storage failed again (disk full); agents stay paused until you use them",
      ),
    );
    expect(host.current()).toBeUndefined();
    expect(await host.ensure(ctx)).toBe(host.current() as never);
  });

  test("memory sessions report their agents lost", async () => {
    const { host, ctx, cwd, notes, fail } = failingHost({ memory: true });
    await host.start(ctx);
    const first = await host.ensure(ctx);
    await first.spawn({ job: "one", name: "w", cwd, model: MODEL });
    await first.wait(["w"]);
    await fail();
    await until(() =>
      notes.includes(
        "pi-agents: Agent storage failed (disk full); this session keeps agents in memory, so they are lost",
      ),
    );
    expect(host.current()).toBeUndefined();
    expect((await host.ensure(ctx)).get("w")).toBeUndefined();
  });
});
