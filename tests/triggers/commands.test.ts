import { describe, expect, test } from "bun:test";
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
  completeRunArgs,
  findNodeInRun,
  formatNodeResultFull,
  formatRunDetails,
  formatRunNodesList,
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
  handler: (agent: string | undefined, task: string) => string,
  keep: (event: RunEvent) => boolean = () => true,
): Promise<RunView> {
  const flow = validateFlow(raw);
  const events: RunEvent[] = [];
  await executeFlow({
    runId: "run-1234-abcd",
    flow,
    label: "review",
    runAgent: async (call) => ({ text: handler(call.agent, call.task) }),
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
    expect(text).toContain("Full output: `/run run-1234 result <name>`");
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

  test("non-string values remain fenced, pretty-printed JSON", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.value = { findings: [1, 2] };
    const text = formatNodeResultFull(run, target);
    expect(text).toContain('```\n{\n  "findings": [');
    expect(text).toContain("\n}\n```");
  });

  test("puts truncation metadata before a split Markdown fence", async () => {
    const run = await recordedRun(REVIEW_FLOW, () => "ok");
    const target = workNodes(run)[0] as NodeView;
    target.value = `\`\`\`ts\n${"x".repeat(64_100)}\n\`\`\``;
    const text = formatNodeResultFull(run, target);
    expect(text.indexOf("… truncated")).toBeLessThan(text.indexOf("```ts"));
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
  test("puts the full-result hint before a split preview fence", async () => {
    const markdown = `\`\`\`ts\n${"x".repeat(500)}\n\`\`\``;
    const run = await recordedRun(REVIEW_FLOW, () => markdown);
    const text = formatRunDetails(run);
    expect(text.indexOf("Full result:")).toBeLessThan(text.indexOf("```ts"));
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
      "result",
      "agents",
      "watch",
      "mermaid",
      "stop",
    ]);
    expect(completions[0]?.value).toBe("run-1234 result");
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
