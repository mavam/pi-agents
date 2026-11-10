import { describe, expect, test } from "bun:test";
import { PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import {
  createHarnessSettings,
  harnessIdentity,
} from "../../src/host/harness-setup.js";

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

  test("agents stream with Pi's transport, thinking budgets, and timeouts", () => {
    const stream = createHarnessSettings(
      SettingsManager.inMemory({
        transport: "websocket",
        thinkingBudgets: { low: 1024 },
        websocketConnectTimeoutMs: 5000,
      }),
    ).stream;
    expect(stream).toMatchObject({
      transport: "websocket",
      thinkingBudgets: { low: 1024 },
      websocketConnectTimeoutMs: 5000,
    });
    const defaults = createHarnessSettings(SettingsManager.inMemory()).stream;
    expect(defaults).not.toHaveProperty("thinkingBudgets");
    expect(defaults).not.toHaveProperty("websocketConnectTimeoutMs");
  });

  test("agents attribute requests to Pi only while telemetry is enabled", () => {
    const enabled = SettingsManager.inMemory({ enableInstallTelemetry: true });
    const disabled = SettingsManager.inMemory({
      enableInstallTelemetry: false,
    });
    expect(harnessIdentity(enabled, undefined)).toEqual({
      userAgent: "detailed",
      version: VERSION,
      attribution: PI_ATTRIBUTION,
    });
    expect(harnessIdentity(disabled, undefined).attribution).toBeNull();
    // The environment overrides the setting either way.
    expect(harnessIdentity(disabled, "Yes").attribution).toEqual(
      PI_ATTRIBUTION,
    );
    expect(harnessIdentity(enabled, "0").attribution).toBeNull();
  });
});
