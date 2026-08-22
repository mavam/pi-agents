import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../src/protocol.js";
import {
  formatRunNotificationControls,
  type RunNotificationDetails,
  renderResultValue,
  renderRunNotification,
} from "../../src/ui/render.js";

beforeAll(() => initTheme(undefined, false));

const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

type CompletedDetails = Extract<
  RunNotificationDetails,
  { status: "completed" }
>;

function details(overrides: Partial<CompletedDetails> = {}): CompletedDetails {
  return {
    kind: "run_final",
    protocol: PROTOCOL_VERSION,
    runId: "9a7eb000-full",
    label: "dummy-node-exploration-2",
    status: "completed",
    agents: 4,
    copyable: true,
    bodyKind: "result",
    body: "done",
    at: 1,
    ...overrides,
  };
}

function finalDetails(
  outcome: { status: "failed"; body: string } | { status: "stopped" },
): RunNotificationDetails {
  const base = {
    kind: "run_final" as const,
    protocol: PROTOCOL_VERSION,
    runId: "9a7eb000-full",
    label: "dummy-node-exploration-2",
    agents: 1,
    copyable: false,
    at: 1,
  };
  return outcome.status === "failed"
    ? {
        ...base,
        status: "failed",
        bodyKind: "error",
        body: outcome.body,
      }
    : { ...base, status: "stopped", bodyKind: "none" };
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

describe("structured result rendering", () => {
  test("labels adaptive fences as JSON", () => {
    const json = '{\n  "report": "```markdown"\n}';
    expect(renderResultValue({ report: "```markdown" }, json)).toBe(
      `\`\`\`\`json\n${json}\n\`\`\`\``,
    );
  });
});

describe("run notification controls", () => {
  test("renders a compact glyph-prefixed usage line", () => {
    expect(formatRunNotificationControls("9a7eb000-full", true)).toBe(
      "❖ `/workflow 9a7eb000` [copy|result|raw|agents]",
    );
    expect(formatRunNotificationControls("9a7eb000-full", false)).toBe(
      "❖ `/workflow 9a7eb000` [result|raw|agents]",
    );
  });

  test("dims the whole line when a theme is supplied", () => {
    expect(
      formatRunNotificationControls("9a7eb000-full", true, markerTheme),
    ).toBe(
      "<muted>❖</muted> <dim>/workflow 9a7eb000 [copy|result|raw|agents]</dim>",
    );
  });
});

describe("run notification renderer", () => {
  test("styles completion cards with the custom message background", () => {
    const output = render(details({ usage: "3 turns ↑12.0k ↓4.0k $0.0500" }));

    expect(
      output.split("\n").every((line) => line.startsWith("<customMessageBg>")),
    ).toBe(true);
    expect(output).toContain("<muted>❖</muted>");
    expect(output).toContain("<bold>dummy-node-exploration-2</bold>");
    expect(output).toContain("<dim> · 9a7eb000 · </dim>");
    expect(output).toContain("<success>● completed</success>");
    expect(output).toContain(
      "<dim> · 3 turns ↑12.0k ↓4.0k $0.0500 · 4 agents</dim>",
    );
    expect(output).toContain(
      "<muted>❖</muted> <dim>/workflow 9a7eb000 [copy|result|raw|agents]</dim>",
    );
    expect(output).toContain("done");
    expect(output.indexOf("done")).toBeLessThan(
      output.indexOf("/workflow 9a7eb000 [copy|result|raw|agents]"),
    );
    expect(output).not.toContain("Continue your task");
  });

  test("renders failed and stopped cards without unreachable statuses", () => {
    const failed = render(
      finalDetails({ status: "failed", body: "agent exploded" }),
    );
    expect(failed).toContain("<error>✗ failed</error>");
    expect(failed).toContain("agent exploded");
    expect(failed).toContain("[result|raw|agents]");
    expect(failed).not.toContain("[copy|");

    const stopped = render(finalDetails({ status: "stopped" }));
    expect(stopped).toContain("<dim>⊘ stopped</dim>");
    expect(stopped).not.toContain("agent exploded");
    expect(stopped).not.toContain("Run stopped.");
    expect(stopped).toContain("[result|raw|agents]");
    expect(stopped).not.toContain("[copy|");
  });

  test("omits copy from completed cards without output", () => {
    const output = render(details({ body: "(no output)", copyable: false }));

    expect(output).toContain("<success>● completed</success>");
    expect(output).toContain("(no output)");
    expect(output).toContain("[result|raw|agents]");
    expect(output).not.toContain("[copy|");
  });

  test("rejects inconsistent protocol details and falls back to content", () => {
    const output = render(
      {
        ...details(),
        status: "stopped",
        bodyKind: "result",
        body: "must not render",
      },
      "**Malformed details fallback.**",
    );

    expect(output).toContain("Malformed details fallback.");
    expect(output).not.toContain("must not render");
    expect(output).not.toContain("<muted>❖</muted>");
  });

  test("falls back to message Markdown for invalid persisted details", () => {
    const output = render(
      {
        kind: "run_final",
        runId: "invalid-run",
        label: "invalid",
        status: "completed",
        text: "ignored invalid content",
        at: 1,
      },
      "**Fallback content.**",
    );

    expect(output).toContain("Fallback content.");
    expect(output).not.toContain("<muted>❖</muted>");
  });
});
