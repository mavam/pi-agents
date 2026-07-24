import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../src/engine/types.js";
import type { RunEvent } from "../../src/run/events.js";
import type { RunManager } from "../../src/run/runs.js";
import { NotificationManager } from "../../src/ui/notify.js";

interface SentMessage {
  message: { content: string };
  options?: { triggerTurn?: boolean };
}

function makeFakes(sessionFile = "session.jsonl") {
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage: (
      message: { content: string },
      options?: SentMessage["options"],
    ) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const manager = { state: { runs: new Map() } } as unknown as RunManager;
  const makeCtx = (idle: boolean): ExtensionContext =>
    ({
      isIdle: () => idle,
      sessionManager: { getSessionFile: () => sessionFile },
    }) as unknown as ExtensionContext;
  return { sent, pi, manager, makeCtx };
}

function completed(runId: string, value: unknown = "done"): RunEvent {
  return {
    type: "run_completed",
    at: 1,
    runId,
    status: "completed",
    value,
    usage: emptyUsage(),
    agents: 1,
  };
}

describe("NotificationManager", () => {
  test("tool-launched run triggers a turn on completion", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", true);
    notifications.handleRunEvent(completed("run-1"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ triggerTurn: true });
    expect(sent[0]?.message.content).toContain(
      "Continue your task using this result.",
    );
  });

  test("non-tool run delivers without triggering a turn", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    notifications.handleRunEvent(completed("run-1"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toBeUndefined();
    expect(sent[0]?.message.content).not.toContain(
      "Continue your task using this result.",
    );
  });

  test("renders string result previews as Markdown", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    const markdown = "## Change map\n\n- **AST and structural parsing**";
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    expect(content.indexOf("Inspect with")).toBeLessThan(
      content.indexOf(markdown),
    );
    expect(content.endsWith(markdown)).toBe(true);
    expect(content).not.toContain(`\`\`\`\n${markdown}`);
  });

  test("keeps structured result previews as fenced JSON", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    notifications.handleRunEvent(
      completed("run-1", { findings: ["one", "two"] }),
    );
    const content = sent[0]?.message.content ?? "";
    expect(content.indexOf("Inspect with")).toBeLessThan(
      content.indexOf('```\n{\n  "findings": ['),
    );
    expect(content).toContain("\n}\n```");
  });

  test("puts host controls before a split Markdown preview fence", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", true);
    const markdown = `\`\`\`ts\n${"x".repeat(700)}\n\`\`\``;
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    const resultStart = content.indexOf("```ts");
    expect(content.indexOf("Inspect with")).toBeLessThan(resultStart);
    expect(content.indexOf("Continue your task")).toBeLessThan(resultStart);
  });

  test("completion while busy queues; flush when idle triggers a turn", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(false));
    notifications.track("run-1", "session.jsonl", true);
    notifications.handleRunEvent(completed("run-1"));
    expect(sent).toHaveLength(0);
    notifications.flush(makeCtx(true));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ triggerTurn: true });
  });

  test("hasPending reflects queued notifications", () => {
    const { pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(false));
    notifications.track("run-1", "session.jsonl", true);
    expect(notifications.hasPending()).toBe(false);
    notifications.handleRunEvent(completed("run-1"));
    expect(notifications.hasPending()).toBe(true);
    notifications.flush(makeCtx(true));
    expect(notifications.hasPending()).toBe(false);
  });

  test("flush against a still-busy context keeps the notification queued", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(false));
    notifications.track("run-1", "session.jsonl", true);
    notifications.handleRunEvent(completed("run-1"));
    notifications.flush(makeCtx(false));
    expect(sent).toHaveLength(0);
    expect(notifications.hasPending()).toBe(true);
  });
});
