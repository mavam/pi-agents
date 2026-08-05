import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { validateFlow } from "../../src/model/validate.js";
import type { RunEvent, RunSource } from "../../src/run/events.js";
import { executeFlow } from "../../src/run/interpreter.js";
import { type RunView, rebuildRunState } from "../../src/run/state.js";
import {
  buildWorkflowsSpec,
  type CommandDeps,
  registerCommands,
  type WorkflowsItem,
} from "../../src/triggers/commands.js";
import { plainColorize } from "../../src/ui/widget.js";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "workflows.json"),
    JSON.stringify({ bundledWorkflows: false }),
  );
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeWorkflow(name: string, description = "A test workflow"): void {
  fs.writeFileSync(
    path.join(projectDir, ".pi", "workflows", `${name}.yaml`),
    `name: ${name}\ndescription: ${description}\ntask: "Do the thing"\n`,
  );
}

async function makeRun(
  runId: string,
  source: RunSource,
  opts: { running?: boolean } = {},
): Promise<RunView> {
  const flow = validateFlow({ kind: "agent", task: "t" });
  const events: RunEvent[] = [];
  await executeFlow({
    runId,
    flow,
    label: source.workflow,
    source,
    runAgent: async () => ({ value: "ok" }),
    emit: (event) => events.push(event),
  });
  const kept = opts.running
    ? events.filter(
        (event) =>
          event.type !== "run_completed" && event.type !== "node_completed",
      )
    : events;
  const run = rebuildRunState(kept).runs.get(runId);
  if (!run) throw new Error("missing run");
  return run;
}

interface FakePi {
  pi: ExtensionAPI;
  messages: string[];
  commands: Map<
    string,
    {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      getArgumentCompletions?: (
        prefix: string,
      ) => Array<{ value: string; label: string }>;
    }
  >;
}

function fakePi(): FakePi {
  const messages: string[] = [];
  const commands: FakePi["commands"] = new Map();
  const pi = {
    registerCommand: (name: string, def: unknown) =>
      commands.set(name, def as never),
    sendMessage: (msg: { content?: string }) =>
      messages.push(String(msg.content ?? "")),
  } as unknown as ExtensionAPI;
  return { pi, messages, commands };
}

interface FakeDeps {
  deps: CommandDeps;
  toggles: string[];
  suppressions: boolean[];
}

function fakeDeps(runs: RunView[]): FakeDeps {
  const state = { runs: new Map(runs.map((run) => [run.header.id, run])) };
  const toggles: string[] = [];
  const suppressions: boolean[] = [];
  const deps = {
    manager: {
      state,
      steerableInstances: () => [] as string[],
      stop: () => false,
      find: (idOrPrefix: string) => {
        const exact = state.runs.get(idOrPrefix);
        if (exact) return { kind: "found", run: exact };
        const matches = [...state.runs.values()].filter((run) =>
          run.header.id.startsWith(idOrPrefix),
        );
        if (matches.length === 1) return { kind: "found", run: matches[0] };
        if (matches.length > 1) return { kind: "ambiguous", matches };
        return { kind: "missing" };
      },
    },
    widget: {
      isHidden: () => false,
      toggleHidden: () => true,
      toggleEnabled: () => {
        toggles.push("widget");
        return true;
      },
      setSuppressed: (value: boolean) => suppressions.push(value),
    },
    notifications: { setContext: () => {} },
  } as unknown as CommandDeps;
  return { deps, toggles, suppressions };
}

function fakeCtx(): ExtensionCommandContext {
  return {
    cwd: projectDir,
    hasUI: false,
    mode: "rpc",
    isProjectTrusted: () => true,
    ui: { notify: () => {}, setEditorText: () => {} },
  } as unknown as ExtensionCommandContext;
}

function fakeTuiCtx(): ExtensionCommandContext {
  return {
    ...fakeCtx(),
    hasUI: true,
    mode: "tui",
    ui: {
      notify: () => {},
      setEditorText: () => {},
      custom: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

const color = plainColorize;

describe("buildWorkflowsSpec", () => {
  async function fixture() {
    writeWorkflow("triage", "Triage findings");
    const done = await makeRun("aaaa1111-run", {
      kind: "command",
      workflow: "triage",
    });
    const live = await makeRun(
      "bbbb2222-run",
      { kind: "command", workflow: "triage" },
      { running: true },
    );
    const adhoc = await makeRun("cccc3333-run", { kind: "tool" });
    const { deps } = fakeDeps([done, live, adhoc]);
    const spec = buildWorkflowsSpec(fakePi().pi, deps, fakeCtx());
    return { spec, done, live, adhoc };
  }

  test("tier 1 lists the all-runs group, workflows with badges, and ad-hoc", async () => {
    const { spec } = await fixture();
    const items = spec.items();
    expect(items[0]?.kind).toBe("all");
    expect(items.at(-1)?.kind).toBe("adhoc");
    const wf = items.find((item) => item.kind === "workflow");
    if (wf?.kind !== "workflow") throw new Error("expected workflow row");
    expect(wf.wf.name).toBe("triage");
    const row = spec.row(wf, color);
    expect(row).toContain("/triage");
    expect(row).toContain("◉1");
    expect(row).toContain("●1");
    expect(spec.row(items[0] as WorkflowsItem, color)).toContain("all runs");
    expect((spec.title as () => string)()).toBe("Workflows");
  });

  test("enter on a workflow drills into that workflow's runs, newest first", async () => {
    const { spec, live } = await fixture();
    const wf = spec.items().find((item) => item.kind === "workflow");
    if (!wf) throw new Error("expected workflow row");
    const action = spec.onAction("enter", wf);
    expect(action).toEqual({ selectKey: `run:${live.header.id}` });
    const items = spec.items();
    expect(items.every((item) => item.kind === "run")).toBe(true);
    expect(
      items.map(
        (item) => item.kind === "run" && item.run.header.source.workflow,
      ),
    ).toEqual(["triage", "triage"]);
    expect(items[0]?.kind === "run" && items[0].run.header.id).toBe(
      live.header.id,
    );
    expect((spec.title as () => string)()).toBe("Runs · /triage");
  });

  test("the ad-hoc group contains only runs without a workflow", async () => {
    const { spec, adhoc } = await fixture();
    const group = spec.items().find((item) => item.kind === "adhoc");
    if (!group) throw new Error("expected adhoc row");
    spec.onAction("enter", group);
    const items = spec.items();
    expect(
      items.map((item) => item.kind === "run" && item.run.header.id),
    ).toEqual([adhoc.header.id]);
    expect((spec.title as () => string)()).toBe("Runs · ad-hoc");
  });

  test("the all group contains every run", async () => {
    const { spec } = await fixture();
    const group = spec.items().find((item) => item.kind === "all");
    if (!group) throw new Error("expected all row");
    spec.onAction("enter", group);
    expect(spec.items()).toHaveLength(3);
    expect((spec.title as () => string)()).toBe("Runs");
  });

  test("run and agent detail panes receive complete results", async () => {
    const { spec, done } = await fixture();
    const workflow = spec
      .items()
      .find((item) => item.kind === "workflow" && item.wf.name === "triage");
    if (!workflow) throw new Error("expected workflow row");
    spec.onAction("enter", workflow);

    const runItem = spec
      .items()
      .find((item) => item.kind === "run" && item.run === done);
    if (runItem?.kind !== "run") throw new Error("expected completed run row");
    const runResult = `${"r".repeat(700)}run-tail`;
    done.value = runResult;
    expect(spec.detail(runItem, color).join("\n")).toContain(runResult);

    spec.onAction("a", runItem);
    const nodeItem = spec.items()[0];
    if (nodeItem?.kind !== "node") throw new Error("expected node row");
    const nodeResult = `${"n".repeat(700)}node-tail`;
    nodeItem.node.value = nodeResult;
    expect(spec.detail(nodeItem, color).join("\n")).toContain(nodeResult);
  });

  test("a on a run drills into its agents; esc pops one tier at a time", async () => {
    const { spec, live } = await fixture();
    const wf = spec.items().find((item) => item.kind === "workflow");
    if (!wf) throw new Error("expected workflow row");
    spec.onAction("enter", wf);
    const runItem = spec.items()[0];
    if (runItem?.kind !== "run") throw new Error("expected run row");
    const action = spec.onAction("a", runItem);
    expect(action).toEqual({ selectKey: `node:${live.header.id}:$` });
    expect(spec.items().every((item) => item.kind === "node")).toBe(true);
    expect((spec.title as () => string)()).toBe(
      `Run ${live.header.id.slice(0, 8)} · agents`,
    );
    // esc: agents -> runs -> workflows -> close.
    expect(spec.onCancel?.()).toEqual({ selectKey: `run:${live.header.id}` });
    expect(spec.items().every((item) => item.kind === "run")).toBe(true);
    expect(spec.onCancel?.()).toEqual({ selectKey: "wf:project:triage" });
    expect(spec.items()[0]?.kind).toBe("all");
    expect(spec.onCancel?.()).toBe("close");
  });

  test("t opens an auto-following agent tail and esc returns to agents", async () => {
    const { spec, live } = await fixture();
    const node = live.nodes.get("$");
    if (!node) throw new Error("expected live node");
    node.progressTail = [
      "assistant · turn 1",
      "✓ reported by the test runner",
      "",
      "✓ read: src/index.ts",
      "assistant · literal tool output",
    ].join("\n");

    const wf = spec.items().find((item) => item.kind === "workflow");
    if (!wf) throw new Error("expected workflow row");
    spec.onAction("enter", wf);
    const runItem = spec.items()[0];
    if (runItem?.kind !== "run") throw new Error("expected run row");
    spec.onAction("a", runItem);
    const nodeItem = spec.items()[0];
    if (nodeItem?.kind !== "node") throw new Error("expected node row");

    expect(spec.onAction("t", nodeItem)).toEqual({
      selectKey: `node:${live.header.id}:$`,
    });
    expect(spec.items()).toHaveLength(1);
    expect((spec.title as () => string)()).toContain("Live tail");
    expect(spec.detail(nodeItem, color).join("\n")).toContain(
      "✓ reported by the test runner",
    );
    const colored = spec.detail(nodeItem, (tone, text) => `<${tone}>${text}`);
    expect(colored).toContain("<muted>assistant · turn 1");
    expect(colored).toContain("<success>✓ read: src/index.ts");
    expect(colored).toContain("✓ reported by the test runner");
    expect(colored).toContain("assistant · literal tool output");
    expect(colored).not.toContain("<success>✓ reported by the test runner");
    expect(colored).not.toContain("<muted>assistant · literal tool output");
    expect(spec.detailWindow?.(nodeItem)).toBe("tail");
    expect(spec.footerFor?.(nodeItem)).toContain("t agents");

    expect(spec.onCancel?.()).toEqual({
      selectKey: `node:${live.header.id}:$`,
    });
    expect((spec.title as () => string)()).toContain("agents");
  });

  test("keyOf namespaces are distinct per tier", async () => {
    const { spec, done } = await fixture();
    const tier1 = spec.items().map((item) => spec.keyOf(item));
    expect(tier1).toEqual(["all", "wf:project:triage", "adhoc"]);
    const wf = spec.items().find((item) => item.kind === "workflow");
    if (!wf) throw new Error("expected workflow row");
    spec.onAction("enter", wf);
    expect(spec.items().map((item) => spec.keyOf(item))).toContain(
      `run:${done.header.id}`,
    );
  });

  test("workflow detail includes a runs line and the flow tree", async () => {
    const { spec } = await fixture();
    const wf = spec.items().find((item) => item.kind === "workflow");
    if (!wf) throw new Error("expected workflow row");
    const detail = spec.detail(wf, color).join("\n");
    expect(detail).toContain("runs:");
    expect(detail).toContain("⏎ to browse");
    expect(detail).toContain("Do the thing");
  });

  test("live() tracks running runs", async () => {
    const { spec } = await fixture();
    expect(spec.live?.()).toBe(true);
    const settled = await makeRun("dddd4444-run", { kind: "tool" });
    const { deps } = fakeDeps([settled]);
    const idle = buildWorkflowsSpec(fakePi().pi, deps, fakeCtx());
    expect(idle.live?.()).toBe(false);
  });
});

describe("command registration", () => {
  test("registers only /workflow* and /agent* commands — no /runs or /run", async () => {
    const { pi, commands } = fakePi();
    registerCommands(pi, fakeDeps([]).deps);
    expect([...commands.keys()].sort()).toEqual([
      "agent",
      "agents",
      "workflow",
      "workflows",
    ]);
  });

  test("/workflow resolves a saved workflow name before a run-id prefix", async () => {
    writeWorkflow("aaaa1111", "Name that shadows a run id");
    const run = await makeRun("aaaa1111-run", { kind: "tool" });
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([run]).deps);
    await commands.get("workflow")?.handler("aaaa1111", fakeCtx());
    expect(messages.at(-1)).toContain("## /aaaa1111");
  });

  test("/workflow <run-id> separates presented and raw results", async () => {
    const run = await makeRun("aaaa1111-run", { kind: "tool" });
    run.header.display = "report";
    run.value = {
      outcome: "changes_required",
      report: "# Human-facing report",
    };
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([run]).deps);
    const workflow = commands.get("workflow");

    await workflow?.handler("aaaa1111", fakeCtx());
    expect(messages.at(-1)).toContain("## Run aaaa1111");

    await workflow?.handler("aaaa1111 result", fakeCtx());
    const result = messages.at(-1) ?? "";
    expect(result).toContain("— result");
    expect(result).toContain("# Human-facing report");
    expect(result).not.toContain('"outcome": "changes_required"');
    expect(result).toContain("`/workflow aaaa1111 raw`");

    await workflow?.handler("aaaa1111 raw", fakeCtx());
    const raw = messages.at(-1) ?? "";
    expect(raw).toContain("— raw");
    expect(raw).toContain('```json\n{\n  "outcome": "changes_required"');

    const root = [...run.nodes.values()].find((node) => node.kind === "agent");
    if (!root) throw new Error("missing root agent");
    root.label = "raw";
    await workflow?.handler("aaaa1111 result raw", fakeCtx());
    expect(messages.at(-1)).toContain("— raw (ad-hoc)");
  });

  test("/workflow <run-id> raw JSON-encodes string values", async () => {
    const run = await makeRun("bbbb2222-run", { kind: "tool" });
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([run]).deps);

    await commands.get("workflow")?.handler("bbbb2222 raw", fakeCtx());
    expect(messages.at(-1)).toContain('```json\n"ok"\n```');
  });

  test("/workflow rejects run verbs on a workflow name", async () => {
    writeWorkflow("triage");
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([]).deps);
    await commands.get("workflow")?.handler("triage stop", fakeCtx());
    expect(messages.at(-1)).toContain("applies to runs");
  });

  test("/workflow with an unknown target names both nouns", async () => {
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([]).deps);
    await commands.get("workflow")?.handler("nope", fakeCtx());
    expect(messages.at(-1)).toContain("No workflow or run matching");
  });

  test("/workflows runs prints the run list with the /workflow hint", async () => {
    const run = await makeRun("aaaa1111-run", { kind: "tool" });
    const { pi, commands, messages } = fakePi();
    registerCommands(pi, fakeDeps([run]).deps);
    await commands.get("workflows")?.handler("runs", fakeCtx());
    expect(messages.at(-1)).toContain("## Runs");
    expect(messages.at(-1)).toContain("Inspect one with `/workflow <id>`");
  });

  test("only the workflows browser suppresses the live run summary", async () => {
    const { pi, commands } = fakePi();
    const { deps, suppressions } = fakeDeps([]);
    registerCommands(pi, deps);

    await commands.get("agents")?.handler("", fakeTuiCtx());
    expect(suppressions).toEqual([]);

    await commands.get("workflows")?.handler("", fakeTuiCtx());
    expect(suppressions).toEqual([true, false]);
  });

  test("/workflows widget toggles the live summary", async () => {
    const { pi, commands } = fakePi();
    const { deps, toggles } = fakeDeps([]);
    registerCommands(pi, deps);
    await commands.get("workflows")?.handler("widget", fakeCtx());
    expect(toggles).toEqual(["widget"]);
  });
});
