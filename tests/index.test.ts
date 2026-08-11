import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentExtension } from "../src/index.js";

/** A permissive stub: every property access and call yields another stub. */
function anything(): unknown {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive || property === "toString") {
        return () => "";
      }
      return anything();
    },
    apply: () => anything(),
  });
}

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

  test("the root process registers the orchestration tools", () => {
    const registered: string[] = [];
    const pi = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "registerTool") {
            return (tool: { name: string }) => registered.push(tool.name);
          }
          return anything();
        },
      },
    ) as ExtensionAPI;

    registerAgentExtension(pi, 0);
    expect(registered).toEqual([
      "workflow_create",
      "workflow_list",
      "workflow_inspect",
      "workflow_result",
      "workflow_steer",
      "workflow_stop",
    ]);
  });
});
