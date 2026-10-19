import { describe, expect, test } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHarnessSettings } from "../../src/host/harness-setup.js";

describe("harness settings", () => {
  test("agents compact with Pi's per-model token settings", () => {
    const settings = createHarnessSettings(
      SettingsManager.inMemory({
        compaction: {
          reserveTokens: 1000,
          modelOverrides: {
            "faux/small": { reserveTokens: 100, keepRecentTokens: 50 },
            "faux/broken": { reserveTokens: -1 },
          },
        },
      } as never),
    );
    expect(settings.compaction).toMatchObject({
      reserveTokens: 1000,
      modelOverrides: {
        "faux/small": { reserveTokens: 100, keepRecentTokens: 50 },
      },
    });
    expect(settings.compaction?.modelOverrides).not.toHaveProperty(
      "faux/broken",
    );
  });
});
