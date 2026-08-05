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
  options: {
    label?: string;
    workflow?: string;
    kind?: "agent" | "value";
    display?: string;
  },
): void {
  manager.state.runs.set(runId, {
    header: {
      id: runId,
      label: options.label,
      display: options.display,
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
    expect(sent[0]?.message.content).toContain("agent exploded");
    expect(
      sent[0]?.message.content.indexOf("agent exploded") ?? Number.NaN,
    ).toBeLessThan(
      sent[0]?.message.content.indexOf("`/workflow run-fail`") ?? -1,
    );
    expect(sent[0]?.message.content).not.toContain("```\nagent exploded");
    expect(sent[0]?.message.details?.bodyKind).toBe("error");
    expect(sent[0]?.message.details?.copyable).toBe(false);
    expect(sent[0]?.message.content).toContain("[result|raw|agents]");
    expect(sent[0]?.message.content).not.toContain("[copy|");
    expect(sent[1]?.message.content.split("\n")[0]).toBe(
      "❖ `run-stop` · ⊘ stopped",
    );
    expect(sent[1]?.message.content).not.toContain("Run stopped.");
    expect(sent[1]?.message.details?.bodyKind).toBe("none");
    expect(sent[1]?.message.details?.body).toBeUndefined();
    expect(sent[1]?.message.details?.copyable).toBe(false);
    expect(sent[1]?.message.content).toContain("[result|raw|agents]");
    expect(sent[1]?.message.content).not.toContain("[copy|");
  });

  test("omits copy from completed notifications without output", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    const absent = completed("run-absent");
    absent.value = undefined;
    for (const event of [absent, completed("run-empty", "")]) {
      notifications.track(event.runId, "session.jsonl", false);
      notifications.handleRunEvent(event);
    }

    expect(sent).toHaveLength(2);
    for (const { message } of sent) {
      expect(message.details?.status).toBe("completed");
      expect(message.details?.body).toBe("(no output)");
      expect(message.details?.copyable).toBe(false);
      expect(message.content).toContain("[result|raw|agents]");
      expect(message.content).not.toContain("[copy|");
    }
  });

  test("renders complete string results as Markdown", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    const markdown = "## Change map\n\n- **AST and structural parsing**";
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    expect(content.indexOf(markdown)).toBeLessThan(
      content.indexOf("`/workflow run-1`"),
    );
    expect(content).not.toContain(`\`\`\`\n${markdown}`);
    expect(sent[0]?.message.details?.copyable).toBe(true);
    expect(content).toContain("[copy|result|raw|agents]");
  });

  test("keeps complete long structured results as highlighted JSON", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", false);
    const result = {
      findings: ["one", "two"],
      report: "x".repeat(700),
      tail: "complete-tail",
    };
    notifications.handleRunEvent(completed("run-1", result));
    const content = sent[0]?.message.content ?? "";
    const json = JSON.stringify(result, null, 2);
    const fenced = `\`\`\`json\n${json}\n\`\`\``;
    expect(sent[0]?.message.details?.body).toBe(fenced);
    expect(content.indexOf(fenced)).toBeLessThan(
      content.indexOf("`/workflow run-1`"),
    );
  });

  test("renders a declared display field instead of structured data", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const report = `# Code Review\n\n${"Readable finding. ".repeat(50)}`;
    addRun(manager, "run-review", {
      workflow: "review",
      display: "report",
    });
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-review", "session.jsonl", false);
    notifications.handleRunEvent(
      completed("run-review", {
        outcome: "changes_required",
        actionable: [{ id: "BUG-1" }],
        report,
      }),
    );

    expect(sent[0]?.message.details?.body).toBe(report);
    expect(sent[0]?.message.content).toContain('"outcome": "changes_required"');
    expect(sent[0]?.message.content).not.toContain("…");
  });

  test("delivers complete long results before the host controls", () => {
    const { sent, pi, manager, makeCtx } = makeFakes();
    const notifications = new NotificationManager(pi, manager);
    notifications.setContext(makeCtx(true));
    notifications.track("run-1", "session.jsonl", true);
    const markdown = `\`\`\`ts\n${"x".repeat(700)}\ncomplete-tail\n\`\`\``;
    notifications.handleRunEvent(completed("run-1", markdown));
    const content = sent[0]?.message.content ?? "";
    const resultStart = content.indexOf("```ts");
    expect(content.indexOf("Continue your task")).toBeLessThan(resultStart);
    expect(content).toContain("complete-tail");
    expect(resultStart).toBeLessThan(content.indexOf("`/workflow run-1`"));
    expect(sent[0]?.message.details?.body).toBe(markdown);
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
