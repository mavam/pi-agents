import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type RunNotificationDetails,
  renderRunNotification,
} from "../../src/ui/render.js";

beforeAll(() => initTheme(undefined, false));

const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

function details(
  overrides: Partial<RunNotificationDetails> = {},
): RunNotificationDetails {
  return {
    kind: "run_final",
    version: 2,
    runId: "9a7eb000-full",
    label: "dummy-node-exploration-2",
    status: "completed",
    agents: 4,
    bodyKind: "result",
    body: "done",
    at: 1,
    ...overrides,
  };
}

function render(
  notificationDetails: unknown,
  content = "Continue your task using this result.",
): string {
  const component = renderRunNotification(
    {
      role: "custom",
      customType: "pi-agents:notification",
      content,
      display: true,
      details: notificationDetails,
      timestamp: 1,
    } as never,
    { expanded: false },
    markerTheme,
  );
  if (!component) throw new Error("notification renderer returned nothing");
  return component.render(300).join("\n");
}

describe("run notification renderer", () => {
  test("styles the workflow headline and complete status token", () => {
    const output = render(details({ usage: "3 turns ↑12.0k ↓4.0k $0.0500" }));

    expect(output).toContain("<muted>❖</muted>");
    expect(output).toContain("<bold>dummy-node-exploration-2</bold>");
    expect(output).toContain("<dim> · 9a7eb000 · </dim>");
    expect(output).toContain("<success>● completed</success>");
    expect(output).toContain(
      "<dim> · 3 turns ↑12.0k ↓4.0k $0.0500 · 4 agents</dim>",
    );
    expect(output).toContain("/workflow 9a7eb000 result");
    expect(output).toContain("done");
    expect(output).not.toContain("Continue your task");
  });

  test("renders failed and stopped cards without unreachable statuses", () => {
    const failed = render(
      details({
        status: "failed",
        agents: 1,
        bodyKind: "error",
        body: "agent exploded",
      }),
    );
    expect(failed).toContain("<error>✗ failed</error>");
    expect(failed).toContain("agent exploded");

    const stopped = render(
      details({
        status: "stopped",
        bodyKind: "none",
        body: undefined,
      }),
    );
    expect(stopped).toContain("<dim>⊘ stopped</dim>");
    expect(stopped).not.toContain("agent exploded");
    expect(stopped).not.toContain("Run stopped.");
  });

  test("falls back to message Markdown for legacy persisted details", () => {
    const output = render(
      {
        kind: "run_final",
        runId: "legacy-run",
        label: "legacy",
        status: "completed",
        text: "duplicated legacy content",
        at: 1,
      },
      "**Legacy run completed.**",
    );

    expect(output).toContain("Legacy run completed.");
    expect(output).not.toContain("<muted>❖</muted>");
  });
});
