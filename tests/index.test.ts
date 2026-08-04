import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentExtension } from "../src/index.js";

describe("extension process boundary", () => {
  test("delegated processes register no pi-agents surfaces", () => {
    const pi = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(
            `unexpected ExtensionAPI access: ${String(property)}`,
          );
        },
      },
    ) as ExtensionAPI;

    expect(() => registerAgentExtension(pi, 1)).not.toThrow();
  });
});
