import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentDelivery } from "../../src/agents/types.js";
import {
  GRAPH_RESULT_MESSAGE,
  type GraphResultDetails,
  graphContent,
  graphResultDetails,
  RESULT_MESSAGE,
  type ResultDetails,
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

const click: TuiMouseEvent = {
  type: "click",
  button: "left",
  x: 2,
  y: 1,
  screenX: 2,
  screenY: 1,
  width: 80,
  height: 30,
  shift: false,
  alt: false,
  ctrl: false,
};
const text = (card: Component) => card.render(80).join("\n");

function reply(customType: string, details: unknown) {
  const message = {
    customType,
    content: "",
    details,
    display: true,
    timestamp: 0,
  };
  const renderer = renderers.get(customType) as MessageRenderer;
  return (expanded = false) => {
    const card = renderer(message, { expanded, outputPad: 1 }, theme);
    if (!card) throw new Error("Missing reply card");
    return card;
  };
}

const answer: ResultDetails = {
  ...failure(),
  kind: "answered",
  body: longError,
};
const graph: GraphResultDetails = {
  version: 1,
  graphId: "g",
  name: "review",
  policy: "allSettled",
  nodes: [{ ...answer, inputs: [], end: true }],
};

describe("clickable replies", () => {
  test.each([
    ["answer", RESULT_MESSAGE, answer],
    ["failure", RESULT_MESSAGE, failure(longError)],
    ["single graph result", GRAPH_RESULT_MESSAGE, graph],
    [
      "multiple graph results and intermediate failures",
      GRAPH_RESULT_MESSAGE,
      {
        ...graph,
        nodes: [
          ...graph.nodes,
          { ...answer, agentId: "2", name: "summary", inputs: [], end: true },
          { ...failure(longError), inputs: [], end: false },
        ],
      },
    ],
  ] as const)(
    "toggles %s without changing the stored data",
    (_label, type, details) => {
      const original = JSON.stringify(details);
      const render = reply(type, details);
      let card = render();
      expect(text(card)).not.toContain("Error line 20");
      expect(card.handleMouse?.(click)).toEqual({
        handled: true,
        render: true,
      });
      expect(text(card)).toContain("Error line 20");
      expect(text(card)).not.toContain("more lines");
      // Pi recreates custom renderer components when invalidating the transcript.
      card.invalidate();
      card = render();
      expect(text(card)).toContain("Error line 20");
      card.handleMouse?.(click);
      expect(text(card)).not.toContain("Error line 20");
      expect(JSON.stringify(details)).toBe(original);
    },
  );

  test("keeps clicks local, preserves other gestures, and follows global expansion", () => {
    const render = reply(RESULT_MESSAGE, answer);
    let card = render();
    text(card);
    for (const event of [
      { ...click, type: "wheel" as const, wheelDelta: 1 },
      { ...click, type: "drag" as const },
      { ...click, button: "right" as const },
    ])
      expect(card.handleMouse?.(event)).toBeUndefined();
    expect(text(card)).not.toContain("Error line 20");
    card.handleMouse?.(click);
    expect(text(reply(RESULT_MESSAGE, answer)())).not.toContain(
      "Error line 20",
    );
    card = render(true);
    expect(text(card)).toContain("Error line 20");
    card.handleMouse?.(click);
    expect(text(card)).not.toContain("Error line 20");
    expect(text(render(false))).not.toContain("Error line 20");
    expect(text(render(true))).toContain("Error line 20");
    expect(resultContent(answer)).toContain(longError);
  });
});

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
