import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
 * would, in a persistent session unless `memory`.
 */
function failingHost(
  options: {
    memory?: boolean;
    /** Resolves before each storage open after the first. */
    beforeReopen?: () => Promise<void>;
  } = {},
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
  let opens = 0;
  const host = new SessionHost(new TestParent(), {
    openStorage: async (directory) => {
      if (++opens > 1) await options.beforeReopen?.();
      return failing(await openStorage(directory));
    },
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

  test("a shutdown while storage reopens resumes nothing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reopening = false;
    const { host, ctx, directory, fail } = failingHost({
      beforeReopen: () => {
        reopening = true;
        return gate;
      },
    });
    await host.start(ctx);
    const first = await host.ensure(ctx);
    let published = false;
    host.subscribe(() => {
      if (![undefined, first].includes(host.current())) published = true;
    });
    await fail();
    await until(() => reopening);
    const stopping = host.stop();
    release();
    await stopping;
    expect(published).toBe(false);
    expect(host.current()).toBeUndefined();
    expect(lockHolder(directory)).toBeUndefined();
  });

  test("a failed cleanup during recovery is reported", async () => {
    const { host, ctx, notes, directory, fail } = failingHost();
    await host.start(ctx);
    await host.ensure(ctx);
    // The lock can't be removed, as on a read-only directory.
    fs.chmodSync(directory, 0o500);
    try {
      await fail();
      await until(() =>
        notes.some((note) =>
          note.startsWith(
            "pi-agents: Closing the failed agent storage failed: EACCES",
          ),
        ),
      );
    } finally {
      fs.chmodSync(directory, 0o700);
    }
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
