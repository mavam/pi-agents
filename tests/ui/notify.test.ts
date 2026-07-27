import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../../src/engine/types.js";
import type { RunEvent } from "../../src/run/events.js";
import type { RunManager } from "../../src/run/runs.js";
import { NotificationManager } from "../../src/ui/notify.js";
import type { RunNotificationDetails } from "../../src/ui/render.js";

interface SentMessage {
  message: { content: string; details?: RunNotificationDetails };
  options?: { triggerTurn?: boolean };
}

function makeFakes(sessionFile = "session.jsonl") {
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage: (
      message: SentMessage["message"],
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

function addRun(
  manager: RunManager,
  runId: string,
  options: { label?: string; workflow?: string; kind?: "agent" | "value" },
): void {
  manager.state.runs.set(runId, {
    header: {
      id: runId,
      label: options.label,
      source: { kind: "tool", workflow: options.workflow },
      flow:
        options.kind === "value"
          ? { kind: "value", value: null }
          : { kind: "agent", task: "test" },
      depth: 0,
    },
  } as never);
}

type CompletedEvent = Extract<RunEvent, { type: "run_completed" }>;

function completed(runId: string, value: unknown = "done"): CompletedEvent {
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

function failed(runId: string, error = "agent exploded"): CompletedEvent {
  return {
    ...completed(runId),
    status: "failed",
    value: undefined,
    error,
  };
}

function stopped(runId: string): CompletedEvent {
  return {
    ...completed(runId),
    status: "stopped",
    value: undefined,
    error: "Run stopped.",
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

  test("uses the resolved workflow label and compact usage metadata", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    addRun(manager, "9a7eb000-full", { label: "dummy-node-exploration-2" });
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("9a7eb000-full", "session.jsonl", false);
    const event = completed("9a7eb000-full");
    event.usage = {
      ...emptyUsage(),
      turns: 3,
      input: 12_000,
      output: 4_000,
      cost: 0.05,
    };
    event.agents = 4;
    notifications.handleRunEvent(event);

    expect(sent[0]?.message.content.split("\n")[0]).toBe(
      "❖ **dummy-node-exploration-2** · `9a7eb000` · ● completed · 3 turns ↑12.0k ↓4.0k $0.0500 · 4 agents",
    );
    expect(sent[0]?.message.details?.label).toBe("dummy-node-exploration-2");
    expect("text" in (sent[0]?.message.details ?? {})).toBe(false);
  });

  test("falls back from saved workflow to flow kind and omits empty usage", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    addRun(manager, "run-workflow", { workflow: "review" });
    addRun(manager, "run-kind", { kind: "value" });
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    for (const runId of ["run-workflow", "run-kind", "run-missing"]) {
      notifications.track(runId, "session.jsonl", false);
      notifications.handleRunEvent(completed(runId));
    }

    expect(sent[0]?.message.content.split("\n")[0]).toBe(
      "❖ **review** · `run-work` · ● completed",
    );
    expect(sent[1]?.message.content.split("\n")[0]).toBe(
      "❖ **value** · `run-kind` · ● completed",
    );
    expect(sent[2]?.message.content.split("\n")[0]).toBe(
      "❖ `run-miss` · ● completed",
    );
  });

  test("failed runs show a plain error; stopped runs have no body", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-failed", "session.jsonl", false);
    notifications.handleRunEvent(failed("run-failed", "agent exploded"));
    notifications.track("run-stopped", "session.jsonl", false);
    notifications.handleRunEvent(stopped("run-stopped"));

    expect(sent[0]?.message.content.split("\n")[0]).toBe(
      "❖ `run-fail` · ✗ failed",
    );
    expect(sent[0]?.message.content.endsWith("agent exploded")).toBe(true);
    expect(sent[0]?.message.content).not.toContain("```\nagent exploded");
    expect(sent[0]?.message.details?.bodyKind).toBe("error");
    expect(sent[1]?.message.content.split("\n")[0]).toBe(
      "❖ `run-stop` · ⊘ stopped",
    );
    expect(sent[1]?.message.content).not.toContain("Run stopped.");
    expect(sent[1]?.message.details?.bodyKind).toBe("none");
    expect(sent[1]?.message.details?.body).toBeUndefined();
  });

  test("renders complete string results as Markdown", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    const markdown = "## Change map\n\n- **AST and structural parsing**";
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    expect(content.indexOf("Inspect:")).toBeLessThan(content.indexOf(markdown));
    expect(content.endsWith(markdown)).toBe(true);
    expect(content).not.toContain(`\`\`\`\n${markdown}`);
  });

  test("keeps complete structured results as fenced JSON", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    notifications.handleRunEvent(
      completed("run-1", { findings: ["one", "two"] }),
    );
    const content = sent[0]?.message.content ?? "";
    expect(content.indexOf("Inspect:")).toBeLessThan(
      content.indexOf('```\n{\n  "findings": ['),
    );
    expect(content).toContain("\n}\n```");
  });

  test("delivers complete long results after the host controls", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", true);
    const markdown = `\`\`\`ts\n${"x".repeat(700)}\ncomplete-tail\n\`\`\``;
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    const resultStart = content.indexOf("```ts");
    expect(content.indexOf("Inspect:")).toBeLessThan(resultStart);
    expect(content.indexOf("Continue your task")).toBeLessThan(resultStart);
    expect(content.endsWith(markdown)).toBe(true);
    expect(sent[0]?.message.details?.body).toBe(`${markdown.slice(0, 600)}…`);
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
