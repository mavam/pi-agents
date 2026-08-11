import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import {
  type NodeView,
  type RunView,
  rebuildRunState,
  workNodes,
} from "../../src/run/state.js";
import {
  buildWorkflowsSpec,
  completeRunArgs,
  findNodeInRun,
  formatNodeResultFull,
  formatRunDetails,
  formatRunNodesList,
  registerCommands,
  registerWorkflowCommands,
  steeringMarker,
} from "../../src/triggers/commands.js";
import { formatRunSource, nodeDisplayName } from "../../src/ui/render.js";

const REVIEW_FLOW = {
  kind: "parallel",
  branches: {
    bugs: { kind: "agent", name: "reviewer", task: "bugs" },
    clarity: { kind: "agent", name: "reviewer", task: "clarity" },
  },
  reduce: { agent: "worker", task: "merge {branches}" },
};

async function recordedRun(
  raw: unknown,
  handler: (agent: string | undefined, task: string) => unknown,
  keep: (event: RunEvent) => boolean = () => true,
): Promise<RunView> {
  const flow = validateFlow(raw);
  const events: RunEvent[] = [];
  await executeFlow({
    runId: "run-1234-abcd",
    flow,
    label: "review",
    runAgent: async (call) => ({ value: handler(call.agent, call.task) }),
    emit: (event) => events.push(event),
  });
  const run = rebuildRunState(events.filter(keep)).runs.get("run-1234-abcd");
  if (!run) throw new Error("missing run");
  return run;
}

function node(instance: string, extra: Partial<NodeView> = {}): NodeView {
  return {
    path: instance,
    instance,
    kind: "agent",
    status: "completed",
    startedAt: 0,
    ...extra,
  };
}

describe("saved workflow commands", () => {
  test("pass one text argument and render the invocation tree", async () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-command-preview-"),
    );
    try {
      const workflowsDir = path.join(projectDir, ".pi", "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowsDir, "greet.yaml"),
        `name: greet
description: Greet a target
params:
  - name: target
    required: true
  - name: style
    default: friendly
  - name: context
    default: no prior context
task: greet {params.target}
`,
      );
      fs.writeFileSync(
        path.join(workflowsDir, "compare.yaml"),
        `name: compare
description: Compare two targets
params:
  - name: left
    required: true
  - name: right
    required: true
task: compare {params.left} with {params.right}
`,
      );

      const commands = new Map<string, RegisteredCommand>();
      const messages: Array<{ content: string }> = [];
      const pi = {
        registerCommand: (name: string, command: RegisteredCommand) =>
          commands.set(name, command),
        sendMessage: (message: { content: string }) => messages.push(message),
        getThinkingLevel: () => "off",
      } as unknown as ExtensionAPI;
      const done = Promise.resolve({
        status: "completed",
        value: null,
        usage: {},
        agents: 0,
      });
      let starts = 0;
      const deps = {
        pi,
        manager: {
          state: { runs: new Map() },
          start: () => {
            starts += 1;
            return { runId: "12345678-full", done };
          },
          markBackgrounded: () => {},
        },
        notifications: { setContext: () => {}, track: () => {} },
        widget: { update: () => {} },
      } as never;
      const ctx = {
        cwd: projectDir,
        mode: "tui",
        isProjectTrusted: () => true,
        sessionManager: { getSessionFile: () => undefined },
      } as unknown as ExtensionCommandContext;

      registerWorkflowCommands(pi, projectDir, deps);
      const greet = commands.get("greet");
      if (!greet) throw new Error("greet command was not registered");
      await greet.handler("this pull request", ctx);

      expect(messages).toHaveLength(1);
      const preview = messages[0]?.content ?? "";
      expect(preview).toContain("❖ greet");
      expect(preview).toContain("│  target: this pull request");
      expect(preview).not.toContain("style:");
      expect(preview).not.toContain("context:");
      expect(preview).toContain("└─ ✦ ad-hoc · greet {params.target}");
      expect(preview).toContain(
        "\n\nrunning in background · /workflow 12345678",
      );
      expect(preview).not.toContain("Started run");

      await greet.handler('target="this pull request"', ctx);
      expect(messages).toHaveLength(2);
      expect(messages[1]?.content).toContain(
        '│  target: target="this pull request"',
      );

      const compare = commands.get("compare");
      if (!compare) throw new Error("compare command was not registered");
      await compare.handler("left side", ctx);
      expect(messages).toHaveLength(3);
      expect(messages[2]?.content).toContain(
        "/compare requires additional named parameters: right",
      );
      expect(starts).toBe(2);

      registerCommands(pi, deps);
      const inspect = commands.get("workflow");
      if (!inspect) throw new Error("workflow command was not registered");
      await inspect.handler("greet", ctx);
      expect(messages).toHaveLength(4);
      expect(messages[3]?.content).toContain(
        ["```", "❖ greet", "└─ ✦ ad-hoc · greet {params.target}", "```"].join(
          "\n",
        ),
      );

      const spec = buildWorkflowsSpec(pi, deps, ctx);
      const item = spec
        .items()
        .find(
          (candidate) =>
            candidate.kind === "workflow" && candidate.wf.name === "greet",
        );
      if (!item) throw new Error("workflow panel item was not discovered");
      const detail = spec.detail(item, (_color, text) => text);
      expect(detail).toContain("❖ greet");
      expect(detail).toContain("└─ ✦ ad-hoc · greet {params.target}");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("nodeDisplayName", () => {
  test.each([
    ["$.branches.bugs", "bugs"],
    ["$.reduce", "reduce"],
    ["$.body@2", "@2"],
    ["$.body@fileA", "@fileA"],
    ["$.body#3", "#3"],
    ["$.steps[0]", "1"],
    ["$.steps[1].body#3", "2#3"],
    ["$.steps[0].branches.security.reduce", "1.security.reduce"],
    ["$.cases[0].then", "case 1"],
    ["$.else", "else"],
    ["$.steps[1].cases[1].then", "2.case 2"],
  ])("%s → %s", (instance, expected) => {
    expect(nodeDisplayName(node(instance))).toBe(expected);
  });

  test("bare-agent root falls back to label, agent, then kind", () => {
    expect(nodeDisplayName(node("$", { label: "scout" }))).toBe("scout");
    expect(nodeDisplayName(node("$", { agent: "reviewer" }))).toBe("reviewer");
    expect(nodeDisplayName(node("$"))).toBe("agent");
  });
});

describe("formatRunSource", () => {
  test("includes hook events and RPC callers", () => {
    expect(formatRunSource({ kind: "hook", event: "turn_end" })).toBe(
      "hook:turn_end",
    );
    expect(formatRunSource({ kind: "rpc", caller: "pi-dashboard" })).toBe(
      "rpc:pi-dashboard",
    );
    expect(formatRunSource({ kind: "rpc" })).toBe("rpc");
  });
});

describe("steeringMarker", () => {
  test("distinguishes manual, agent, and extension steering", () => {
    expect(steeringMarker({ source: "user" })).toBe("↪");
    expect(steeringMarker({ source: "tool" })).toBe("✦");
    expect(steeringMarker({ source: "rpc", caller: "dashboard" })).toBe(
      "⇢ dashboard:",
    );
    expect(steeringMarker({ source: "rpc" })).toBe("⇢");
  });
});

describe("workNodes", () => {
  test("keeps agent and reduce leaves in order, skips composites", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const kinds = new Set(workNodes(run).map((n) => n.kind));
    expect(kinds).toEqual(new Set(["agent", "reduce"]));
    expect(workNodes(run).map((n) => nodeDisplayName(n))).toEqual([
      "bugs",
      "clarity",
      "reduce",
    ]);
  });

  test("includes cancelled-before-start branches", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    run.nodes.set(
      "$.branches.extra",
      node("$.branches.extra", { status: "cancelled", cancelReason: "any" }),
    );
    run.order.push("$.branches.extra");
    expect(workNodes(run).map((n) => nodeDisplayName(n))).toContain("extra");
  });
});

describe("findNodeInRun", () => {
  test("matches by instance path, display name, and agent name", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const byInstance = findNodeInRun(run, "$.branches.bugs");
    expect(byInstance.kind).toBe("found");
    const byName = findNodeInRun(run, "clarity");
    expect(byName.kind === "found" && byName.node.instance).toBe(
      "$.branches.clarity",
    );
    const byAgent = findNodeInRun(run, "worker");
    expect(byAgent.kind === "found" && byAgent.node.kind).toBe("reduce");
  });

  test("ambiguous agent names list candidates", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const lookup = findNodeInRun(run, "reviewer");
    expect(lookup.kind).toBe("ambiguous");
    expect(
      lookup.kind === "ambiguous" &&
        lookup.matches.map((n) => nodeDisplayName(n)),
    ).toEqual(["bugs", "clarity"]);
  });

  test("unknown reference is missing", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    expect(findNodeInRun(run, "nope").kind).toBe("missing");
  });
});

describe("formatRunNodesList", () => {
  test("lists every work node with a collapsed preview", async () => {
    const run = await recordedRun(REVIEW_FLOW, (agent) =>
      agent === "worker" ? "merged\nfindings" : "some finding",
    );
    const text = formatRunNodesList(run);
    expect(text).toContain("## Run run-1234 — agents");
    expect(text).toContain("bugs");
    expect(text).toContain("clarity");
    expect(text).toContain("reduce");
    expect(text).toContain("worker");
    // Multi-line values collapse to one preview line.
    expect(text).toContain("merged findings");
    expect(text).toContain("Full output: `/workflow run-1234 result <name>`");
  });

  test("empty run says so", async () => {
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) => event.type === "run_created",
    );
    expect(formatRunNodesList(run)).toContain("(no agents started yet)");
  });
});

describe("formatNodeResultFull", () => {
  test("completed node renders its string output as Markdown", async () => {
    const markdown = [
      "## Change map",
      "",
      "- **AST and structural parsing**",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n");
    const run = await recordedRun(REVIEW_FLOW, () => markdown);
    const lookup = findNodeInRun(run, "bugs");
    if (lookup.kind !== "found") throw new Error("expected bugs node");
    const text = formatNodeResultFull(run, lookup.node);
    expect(text).toContain("## Run run-1234 — bugs (reviewer)");
    expect(text).toContain("- status: completed");
    expect(text).toContain(`\n\n${markdown}`);
    // The result's own code fence remains Markdown instead of forcing an
    // outer fence around the entire result.
    expect(text).not.toContain("````\n## Change map");
  });

  test("non-string values remain fenced, highlighted JSON", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.value = { findings: [1, 2] };
    const text = formatNodeResultFull(run, target);
    expect(text).toContain('```json\n{\n  "findings": [');
    expect(text).toContain("\n}\n```");
  });

  test("failed node shows the error", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.status = "failed";
    target.error = "boom";
    target.value = undefined;
    const text = formatNodeResultFull(run, target);
    expect(text).toContain("- status: failed");
    expect(text).toContain("⚠ boom");
    expect(text).not.toContain("(no output value)");
  });

  test("cancelled node shows the reason", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.status = "cancelled";
    target.cancelReason = "sibling_failed";
    const text = formatNodeResultFull(run, target);
    expect(text).toContain("- status: cancelled (sibling_failed)");
  });

  test("running node shows progress instead of a value", async () => {
    const run = await recordedRun(
      REVIEW_FLOW,
      () => "ok",
      (event) =>
        event.type !== "run_completed" &&
        !(
          event.type === "node_completed" &&
          event.instance === "$.branches.bugs"
        ),
    );
    const lookup = findNodeInRun(run, "bugs");
    if (lookup.kind !== "found") throw new Error("expected bugs node");
    expect(formatNodeResultFull(run, lookup.node)).toContain(
      "Still running — no output yet.",
    );
    lookup.node.progressText = "reading files…";
    expect(formatNodeResultFull(run, lookup.node)).toContain("reading files…");
  });

  test("shows accepted steering history and attribution", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.steering.push({
      at: Date.UTC(2026, 6, 23, 12, 0, 0),
      message: "Focus on the retry path.",
      source: "rpc",
      caller: "dashboard",
    });
    const text = formatNodeResultFull(run, target);
    expect(text).toContain("### Steering");
    expect(text).toContain("2026-07-23T12:00:00.000Z (rpc:dashboard)");
    expect(text).toContain("Focus on the retry path.");
  });
});

describe("formatRunDetails", () => {
  test("puts the raw-data hint after a split preview fence", async () => {
    const markdown = `\`\`\`ts\n${"x".repeat(500)}\n\`\`\``;
    const run = await recordedRun(REVIEW_FLOW, () => markdown);
    const text = formatRunDetails(run);
    expect(text.indexOf("```ts")).toBeLessThan(text.indexOf("Raw data:"));
  });

  test("renders a workflow's declared display field", async () => {
    const report = `# Code Review\n\n${"Readable finding. ".repeat(30)}`;
    const run = await recordedRun(
      {
        kind: "agent",
        task: "review",
        json: {
          type: ["null", "boolean", "number", "string", "array", "object"],
        },
      },
      () => ({ outcome: "changes_required", report }),
    );
    run.header.display = "report";

    const text = formatRunDetails(run);
    expect(text).toContain("- display: `report`");
    expect(text).toContain(report);
    expect(text).not.toContain("…");
    expect(text).not.toContain('"outcome": "changes_required"');
    expect(text.indexOf(report)).toBeLessThan(text.indexOf("Raw data:"));
  });

  test("warns before previewing a raw fallback", async () => {
    const run = await recordedRun(
      {
        kind: "agent",
        task: "review",
        json: {
          type: ["null", "boolean", "number", "string", "array", "object"],
        },
      },
      () => ({ findings: [] }),
    );
    run.header.display = "report";

    const text = formatRunDetails(run);
    expect(text).toContain(
      "> ⚠ Display path `report` was not found; showing the raw result.",
    );
    expect(text.indexOf("> ⚠")).toBeLessThan(
      text.indexOf("### Result (preview)"),
    );
  });
});

describe("completeRunArgs", () => {
  const runs = async () => [await recordedRun(REVIEW_FLOW, () => "ok")];

  test("first token completes run ids", async () => {
    const completions = completeRunArgs("run-", await runs());
    expect(completions.map((c) => c.value)).toEqual(["run-1234"]);
  });

  test("second token completes verbs", async () => {
    const completions = completeRunArgs("run-1234 ", await runs());
    expect(completions.map((c) => c.label)).toEqual([
      "copy",
      "result",
      "raw",
      "agents",
      "watch",
      "mermaid",
      "stop",
    ]);
    expect(completions[0]?.value).toBe("run-1234 copy");
  });

  test("third token after result completes node names", async () => {
    const completions = completeRunArgs("run-1234 result ", await runs());
    expect(completions.map((c) => c.label)).toEqual([
      "bugs",
      "clarity",
      "reduce",
    ]);
    expect(completions.at(-1)?.value).toBe("run-1234 result reduce");
    const filtered = completeRunArgs("run-1234 result cl", await runs());
    expect(filtered.map((c) => c.label)).toEqual(["clarity"]);
  });

  test("no completions after other verbs or unknown runs", async () => {
    expect(completeRunArgs("run-1234 watch ", await runs())).toEqual([]);
    expect(completeRunArgs("zzz result ", await runs())).toEqual([]);
  });
});

describe("workflows panel actions", () => {
  function harness() {
    const notices: string[] = [];
    const editorText: string[] = [];
    const ctx = {
      cwd: "/tmp/pi-agents-nonexistent",
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (text: string) => notices.push(text),
        setEditorText: (text: string) => editorText.push(text),
      },
    };
    const deps = {
      manager: { state: { runs: new Map() } },
      notifications: { setContext: () => {} },
      widget: { isHidden: () => false, setSuppressed: () => {} },
    };
    const messages: string[] = [];
    const pi = {
      sendMessage: (m: { content: string }) => messages.push(m.content),
    };
    const spec = buildWorkflowsSpec(pi as never, deps as never, ctx as never);
    return { spec, notices, editorText, messages };
  }

  const workflowItem = (params: unknown[] = []) =>
    ({
      kind: "workflow",
      wf: { name: "deep-test", source: "user", params },
    }) as never;

  test("running a workflow keeps the panel open to watch it", () => {
    const { spec } = harness();
    // Closing would strand the user at the composer with only the live
    // summary — the panel already reports the run it just started.
    expect(spec.onAction("r", workflowItem())).toBeUndefined();
  });

  test("composing prefills only after the panel restores the editor", async () => {
    const { spec, editorText } = harness();
    expect(spec.onAction("c", workflowItem())).toBe("close");
    // ctx.ui.custom() restores its captured editor text during teardown. The
    // prefill must run later or that restore overwrites it.
    expect(editorText).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorText).toEqual(["/deep-test "]);

    const required = [{ name: "target", required: true }];
    expect(spec.onAction("r", workflowItem(required))).toBe("close");
    expect(editorText).toEqual(["/deep-test "]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorText).toEqual(["/deep-test ", "/deep-test "]);
  });

  test("keeps commands needing named parameters in the panel", async () => {
    const { spec, notices, editorText } = harness();
    const required = [
      { name: "left", required: true },
      { name: "right", required: true },
    ];
    const item = workflowItem(required);

    expect(spec.onAction("c", item)).toBeUndefined();
    expect(spec.onAction("r", item)).toBeUndefined();
    expect(notices).toEqual([
      "/deep-test requires additional named parameters: right. Use workflow_create or RPC to supply them.",
      "/deep-test requires additional named parameters: right. Use workflow_create or RPC to supply them.",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editorText).toEqual([]);
  });
});
