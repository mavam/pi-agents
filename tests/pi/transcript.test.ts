import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MessageInfo } from "../../src/agents/types.js";
import { MESSAGE_ENTRY, MessageTranscript } from "../../src/pi/transcript.js";

const message: MessageInfo = {
  id: "m1",
  from: { id: "1", name: "scout" },
  to: { id: "2", name: "notes" },
  text: "bun.lock is 412 KB",
  sentAt: 1_000,
  status: "delivered",
};

describe("transcript", () => {
  test("a message gets one card, also after Pi restarts", () => {
    // Pi's session: the custom entries pi-agents appended.
    const entries: Array<{ type: string; customType: string; data: unknown }> =
      [];
    const pi = {
      appendEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data }),
    } as unknown as ExtensionAPI;
    const ctx = {
      sessionManager: { getEntries: () => entries },
    } as unknown as ExtensionContext;

    const first = new MessageTranscript(pi);
    first.start(ctx);
    first.sync([message]);
    first.sync([message]);
    expect(entries.map((entry) => entry.customType)).toEqual([MESSAGE_ENTRY]);

    // After a restart, the session's entries say what it shows already.
    const second = new MessageTranscript(pi);
    second.start(ctx);
    second.sync([message, { ...message, id: "m2" }]);
    expect(entries).toHaveLength(2);

    // An invalid timestamp doesn't identify a transcript message.
    for (const sentAt of [undefined, "1000", Number.NaN]) {
      entries.length = 0;
      entries.push({
        type: "custom",
        customType: MESSAGE_ENTRY,
        data: {
          version: 1,
          key: "m1@1000",
          from: "scout",
          to: "notes",
          text: message.text,
          sentAt,
        },
      });
      const restarted = new MessageTranscript(pi);
      restarted.start(ctx);
      restarted.sync([message]);
      expect(entries).toHaveLength(2);
    }
  });
});
