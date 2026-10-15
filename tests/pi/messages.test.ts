import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentDelivery } from "../../src/agents/types.js";
import {
  GRAPH_RESULT_MESSAGE,
  graphContent,
  graphResultDetails,
  RESULT_MESSAGE,
  registerMessageRenderers,
  resultContent,
  resultDetails,
} from "../../src/pi/messages.js";

const renderers = new Map<string, MessageRenderer>();
registerMessageRenderers({
  registerMessageRenderer: (name: string, renderer: MessageRenderer) =>
    renderers.set(name, renderer),
} as ExtensionAPI);
const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
} as Theme;

function draw(customType: string, details: unknown, expanded = false): string {
  return (
    renderers
      .get(customType)?.(
        { customType, content: "", details, display: true, timestamp: 0 },
        { expanded, outputPad: 1 },
        theme,
      )
      ?.render(80)
      .join("\n") ?? ""
  );
}

function failure(detail?: string) {
  const delivery: AgentDelivery = {
    kind: "agent",
    id: "delivery",
    agentId: "1",
    name: "reviewer",
    requestIds: ["request"],
    outcome: { kind: "failed", reason: "model_error", detail },
  };
  return resultDetails(delivery, undefined);
}

const longError = Array.from(
  { length: 20 },
  (_, i) => `Error line ${i + 1}`,
).join("\n");

describe("failure result messages", () => {
  test.each([undefined, "", "model_error"])(
    "keeps the reason without a distinct detail (%s)",
    (detail) => {
      expect(failure(detail).body).toBe("model_error");
    },
  );

  test("collapses error cards without truncating the parent's context", () => {
    const details = failure(longError);
    expect(resultContent(details)).toBe(
      `Agent reviewer failed: model_error\n\n${longError}`,
    );
    const collapsed = draw(RESULT_MESSAGE, details);
    expect(collapsed).toContain("model_error");
    expect(collapsed).toContain("Error line 1");
    expect(collapsed).toContain("more lines");
    expect(collapsed).not.toContain("Error line 20");
    expect(draw(RESULT_MESSAGE, details, true)).toContain("Error line 20");
  });

  test("collapses intermediate graph failures as well as end results", () => {
    const details = graphResultDetails(
      { id: "graph", name: "review", policy: "allSettled" },
      [
        {
          agentId: "1",
          name: "reviewer",
          inputs: [],
          end: false,
          outcome: { kind: "failed", reason: longError },
        },
        {
          agentId: "2",
          name: "summary",
          inputs: ["1"],
          end: true,
          outcome: { kind: "skipped" },
        },
      ],
      () => undefined,
    );
    expect(graphContent(details)).toContain(longError);
    expect(draw(GRAPH_RESULT_MESSAGE, details)).toContain("more lines");
    expect(draw(GRAPH_RESULT_MESSAGE, details)).not.toContain("Error line 20");
    expect(draw(GRAPH_RESULT_MESSAGE, details, true)).toContain(
      "Error line 20",
    );
  });
});
