import { expect, test } from "bun:test";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Storage } from "@earendil-works/pi-durable";
import { openStorage } from "../../src/host/storage.js";
import { SessionHost } from "../../src/pi/session.js";
import {
  createFaux,
  MODEL,
  TestParent,
  tempDir,
  until,
} from "../agents/helpers.js";

test("a storage failure pauses agents and reopens their storage", async () => {
  const { models } = createFaux();
  // The next storage call after `failNext` throws, as a full disk would.
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
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: (text: string) => notes.push(text) },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "failing",
      getSessionFile: () => path.join(cwd, "session.jsonl"),
      getEntries: () => [],
    },
    modelRegistry: { runtime: models, getAvailable: () => [] },
  } as unknown as ExtensionContext;
  const host = new SessionHost(new TestParent(), {
    openStorage: async (directory) => failing(await openStorage(directory)),
  });
  await host.start(ctx);
  const first = await host.ensure(ctx);
  try {
    await first.spawn({ job: "one", name: "w", cwd, model: MODEL });
    await first.wait(["w"]);

    failNext = true;
    await expect(
      first.spawn({ job: "two", name: "v", cwd, model: MODEL }),
    ).rejects.toThrow();
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
  } finally {
    await host.stop();
  }
});
