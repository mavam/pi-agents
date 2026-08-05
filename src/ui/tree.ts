/**
 * Icon-based flow trees: the human-readable rendering of the algebra. The
 * JSON/YAML form stays canonical for authoring; this is how flows are shown —
 * in the tool call display, /workflow details, and run inspection (where
 * kind icons are replaced by live status icons).
 *
 *   ✦ agent   ≡ sequence (transparent)   ⑃ parallel   ⑂ reduce   ⇶ map
 *   ↺ loop/while
 *   ⎇ switch   ≔ value   ❖ workflow
 */

import {
  ADHOC_LABEL,
  bodyPath,
  branchPath,
  casePath,
  DEFAULT_BUDGETS,
  elsePath,
  type FlowNode,
  type ParMode,
  reducePath,
  stepPath,
} from "../model/ast.js";
import { parseTemplate } from "../model/interpolate.js";
import { formatPredicate } from "../model/predicate.js";
import type { NodeView, RunView } from "../run/state.js";
import { STATUS_STYLES } from "./status.js";

export const KIND_ICONS = {
  agent: "✦",
  sequence: "≡",
  parallel: "⑃",
  reduce: "⑂",
  map: "⇶",
  loop: "↺",
  while: "↺",
  switch: "⎇",
  value: "≔",
  workflow: "❖",
} as const;

const TASK_PREVIEW_CHARS = 56;

/**
 * Dataflow-first coloring: `{references}` in accent, prose and connectors
 * dim, kind glyphs muted, status icons by outcome (green when completed).
 * The identity default keeps plain contexts (markdown code fences, tests)
 * byte-identical.
 */
export type TreeColorize = (
  color: "accent" | "dim" | "muted" | "success" | "warning" | "error",
  text: string,
) => string;

const plainTree: TreeColorize = (_color, text) => text;

/** Dim prose with every {reference} highlighted in accent. */
function colorizeRefs(text: string, color: TreeColorize): string {
  return parseTemplate(text)
    .map((part) =>
      part.kind === "ref" ? color("accent", part.raw) : color("dim", part.text),
    )
    .join("");
}

interface DisplayNode {
  /** Line text, without the leading kind/status icon. */
  text: string;
  /** Kind icon; absent for pure grouping lines (multi-node parallel branches). */
  icon?: string;
  /** Rendered before the icon (e.g. a parallel branch key: "bugs → "). */
  prefixText?: string;
  /** Static node path, for status overlay lookup. */
  path?: string;
  /** Exactly one child subtree can execute (used to derive skipped arms). */
  exclusiveChildren?: boolean;
  children: DisplayNode[];
}

function preview(task: string): string {
  const flat = task.replace(/\s+/g, " ").trim();
  return flat.length <= TASK_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, TASK_PREVIEW_CHARS)}…`;
}

function binding(node: FlowNode, color: TreeColorize): string {
  return node.as
    ? `${color("dim", " → ")}${color("accent", `{${node.as}}`)}`
    : "";
}

function modeText(mode: ParMode | undefined): string {
  if (mode === undefined || mode === "all") return "all";
  if (mode === "any") return "any";
  return `quorum ${mode.quorum}`;
}

/** Build display nodes. Sequence is transparent: one node per step. */
function build(
  node: FlowNode,
  path: string,
  color: TreeColorize,
): DisplayNode[] {
  const reduceNode = (
    reduce: { agent?: string; task: string },
    parentPath: string,
  ): DisplayNode => ({
    icon: KIND_ICONS.reduce,
    text: `reduce${color("dim", " → ")}${reduce.agent ?? ADHOC_LABEL}${color("dim", " · ")}${colorizeRefs(preview(reduce.task), color)}`,
    path: reducePath(parentPath),
    children: [],
  });
  switch (node.kind) {
    case "agent":
      return [
        {
          icon: KIND_ICONS.agent,
          text: `${node.name ?? ADHOC_LABEL}${binding(node, color)}${color("dim", " · ")}${colorizeRefs(preview(node.task), color)}`,
          path,
          children: [],
        },
      ];
    case "sequence": {
      return node.steps.flatMap((step, index) =>
        build(step, stepPath(path, index), color),
      );
    }
    case "parallel": {
      const extras = [
        node.onError === "collect" ? "collect errors" : undefined,
        node.concurrency !== undefined ? `×${node.concurrency}` : undefined,
      ].filter(Boolean);
      const children: DisplayNode[] = Object.entries(node.branches).map(
        ([key, branch]) => {
          const subs = build(branch, branchPath(path, key), color);
          if (subs.length === 1) {
            const only = subs[0] as DisplayNode;
            return { ...only, prefixText: `${key}${color("dim", " → ")}` };
          }
          return { text: `${key}:`, children: subs };
        },
      );
      if (node.reduce) children.push(reduceNode(node.reduce, path));
      return [
        {
          icon: KIND_ICONS.parallel,
          text: `parallel (${[modeText(node.mode), ...extras].join(", ")})${binding(node, color)}`,
          path,
          children,
        },
      ];
    }
    case "map": {
      const children = build(node.body, bodyPath(path), color);
      if (node.reduce) children.push(reduceNode(node.reduce, path));
      return [
        {
          icon: KIND_ICONS.map,
          text: `map ${color("accent", node.over)}${node.concurrency !== undefined ? ` (×${node.concurrency})` : ""}${binding(node, color)}`,
          path,
          children,
        },
      ];
    }
    case "loop": {
      const until = node.until ? ` until ${formatPredicate(node.until)}` : "";
      return [
        {
          icon: KIND_ICONS.loop,
          text: `loop ≤${node.max}${until}${binding(node, color)}`,
          path,
          children: build(node.body, bodyPath(path), color),
        },
      ];
    }
    case "while":
      return [
        {
          icon: KIND_ICONS.while,
          text: `while ${formatPredicate(node.condition)} on ${color("accent", node.on)} ≤${node.max}${binding(node, color)}`,
          path,
          children: build(node.body, bodyPath(path), color),
        },
      ];
    case "switch": {
      const arm = (
        key: string,
        sub: FlowNode,
        subPath: string,
      ): DisplayNode => {
        const subs = build(sub, subPath, color);
        if (subs.length === 1) {
          const only = subs[0] as DisplayNode;
          return { ...only, prefixText: `${key}${color("dim", " → ")}` };
        }
        return { text: `${key}:`, path: subPath, children: subs };
      };
      const children = node.cases.map((c, index) =>
        arm(`when ${formatPredicate(c.when)}`, c.then, casePath(path, index)),
      );
      children.push(arm("else", node.else, elsePath(path)));
      return [
        {
          icon: KIND_ICONS.switch,
          text: `switch ${color("accent", node.on)}${binding(node, color)}`,
          path,
          exclusiveChildren: true,
          children,
        },
      ];
    }
    case "value":
      return [
        {
          icon: KIND_ICONS.value,
          text: `${node.label ?? "value"}${binding(node, color)}${color("dim", " · ")}${colorizeRefs(preview(JSON.stringify(node.value) ?? "null"), color)}`,
          path,
          children: [],
        },
      ];
    case "workflow": {
      const params = Object.entries(node.params ?? {})
        .map(([key, value]) => `${key}: ${colorizeRefs(preview(value), color)}`)
        .join(", ");
      return [
        {
          icon: KIND_ICONS.workflow,
          text: `${node.name}${params ? ` (${params})` : ""}${binding(node, color)}`,
          path,
          children: node.body ? build(node.body, bodyPath(path), color) : [],
        },
      ];
    }
  }
}

/** Per-path status aggregation for the run tiers of /workflows and the live widget. */
export interface PathStatus {
  icon: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Node kind at this path (agent/reduce paths carry the work). */
  kind: NodeView["kind"];
  completed: number;
  total: number;
  /** True when no unseen dynamic instance can choose a different switch arm. */
  dynamicInstancesFinal?: boolean;
  /** e.g. "3/5" for map items or "#2/4" for iterative progress. */
  detail?: string;
  error?: string;
}

function collectIterationCaps(
  node: FlowNode,
  path: string,
  budgetCap: number,
  caps: Map<string, number>,
): void {
  switch (node.kind) {
    case "agent":
    case "value":
      return;
    case "sequence":
      node.steps.forEach((step, index) => {
        collectIterationCaps(step, stepPath(path, index), budgetCap, caps);
      });
      return;
    case "parallel":
      Object.entries(node.branches).forEach(([key, branch]) => {
        collectIterationCaps(branch, branchPath(path, key), budgetCap, caps);
      });
      return;
    case "map":
      collectIterationCaps(node.body, bodyPath(path), budgetCap, caps);
      return;
    case "loop":
    case "while":
      caps.set(path, Math.min(node.max, budgetCap));
      collectIterationCaps(node.body, bodyPath(path), budgetCap, caps);
      return;
    case "switch":
      node.cases.forEach((arm, index) => {
        collectIterationCaps(arm.then, casePath(path, index), budgetCap, caps);
      });
      collectIterationCaps(node.else, elsePath(path), budgetCap, caps);
      return;
    case "workflow":
      if (node.body) {
        collectIterationCaps(node.body, bodyPath(path), budgetCap, caps);
      }
      return;
  }
}

export function aggregateStatuses(run: RunView): Map<string, PathStatus> {
  const byPath = new Map<string, NodeView[]>();
  for (const node of run.nodes.values()) {
    const list = byPath.get(node.path) ?? [];
    list.push(node);
    byPath.set(node.path, list);
  }
  const result = new Map<string, PathStatus>();
  for (const [path, nodes] of byPath) {
    const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const node of nodes) counts[node.status] += 1;
    const status =
      counts.running > 0
        ? "running"
        : counts.failed > 0
          ? "failed"
          : counts.cancelled > 0
            ? "cancelled"
            : "completed";
    const detail =
      nodes.length > 1 ? `${counts.completed}/${nodes.length}` : undefined;
    const error = nodes.find((node) => node.error)?.error;
    result.set(path, {
      icon: STATUS_STYLES[status].icon,
      status,
      kind: (nodes[0] as NodeView).kind,
      completed: counts.completed,
      total: nodes.length,
      dynamicInstancesFinal:
        run.status === "completed" ||
        nodes.every((node) => node.instance === node.path),
      detail,
      error,
    });
  }

  // Iteration events already carry dynamic instance ids. Correlate them with
  // their composite nodes, including completed zero-iteration while nodes,
  // and summarize a shared static row as a compact range when necessary.
  const caps = new Map<string, number>();
  collectIterationCaps(
    run.header.flow,
    "$",
    run.header.budgets?.maxIterations ?? DEFAULT_BUDGETS.maxIterations,
    caps,
  );
  for (const [path, cap] of caps) {
    const status = result.get(path);
    if (!status) continue;
    const instances = (byPath.get(path) ?? []).filter(
      (node) => node.kind === "loop" || node.kind === "while",
    );
    if (instances.length === 0) continue;
    const rounds = instances.map(
      (node) => run.loopIterations.get(node.instance) ?? 0,
    );
    const min = Math.min(...rounds);
    const max = Math.max(...rounds);
    const progress = min === max ? `#${max}/${cap}` : `#${min}–${max}/${cap}`;
    status.detail = [status.detail, progress].filter(Boolean).join(" · ");
  }
  return result;
}

function hasObservedStatus(
  node: DisplayNode,
  statuses: Map<string, PathStatus>,
): boolean {
  return (
    (node.path !== undefined && statuses.has(node.path)) ||
    node.children.some((child) => hasObservedStatus(child, statuses))
  );
}

function renderLines(
  nodes: DisplayNode[],
  statuses: Map<string, PathStatus> | undefined,
  prefix: string,
  top: boolean,
  color: TreeColorize,
  forceSkipped = false,
  skipUnobserved = false,
): string[] {
  // Identity colorizers (markdown fences, tests) render plainly.
  const coloring = color("dim", "·") !== "·";
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const connector = top ? "" : last ? "└─ " : "├─ ";
    const childPrefix = top ? "" : prefix + (last ? "   " : "│  ");
    const status = node.path ? statuses?.get(node.path) : undefined;
    const skipped =
      statuses !== undefined &&
      (forceSkipped || (skipUnobserved && !hasObservedStatus(node, statuses)));
    // Static trees mute the kind glyphs. Status overlays keep the kind
    // glyph so fork/join/map structure stays readable mid-run and encode
    // the outcome in its color (matching the run rows and the live
    // widget); plain contexts (markdown fences) have no color to carry
    // state, so they pair the glyph with a status icon instead.
    let icon: string | undefined;
    if (statuses) {
      const presentation =
        STATUS_STYLES[skipped ? "skipped" : (status?.status ?? "pending")];
      const tint = presentation.color;
      const statusGlyph = skipped
        ? presentation.icon
        : (status?.icon ?? presentation.icon);
      icon = coloring
        ? color(tint, node.icon ?? statusGlyph)
        : [statusGlyph, node.icon].filter(Boolean).join(" ");
    } else if (node.icon !== undefined) {
      icon = color("muted", node.icon);
    }
    const detail = !skipped && status?.detail ? ` [${status.detail}]` : "";
    const error =
      !skipped && status?.error ? ` — ${preview(status.error)}` : "";
    const skeleton = `${prefix}${connector}`;
    lines.push(
      `${skeleton ? color("dim", skeleton) : ""}${node.prefixText ?? ""}${icon ? `${icon} ` : ""}${node.text}${detail}${error}`,
    );
    const exclusiveResolved =
      statuses !== undefined &&
      node.exclusiveChildren === true &&
      status?.dynamicInstancesFinal === true &&
      node.children.some((child) => hasObservedStatus(child, statuses));
    lines.push(
      ...renderLines(
        node.children,
        statuses,
        childPrefix,
        false,
        color,
        skipped,
        exclusiveResolved,
      ),
    );
  });
  return lines;
}

/** Static flow tree with kind icons (definitions, tool-call previews). */
export function renderFlowTree(
  flow: FlowNode,
  color: TreeColorize = plainTree,
): string {
  return renderLines(build(flow, "$", color), undefined, "", true, color).join(
    "\n",
  );
}

/**
 * Static tree for a saved workflow definition. The synthetic display-only
 * workflow node makes the title the visual parent of the definition's flow;
 * it never enters validation or execution.
 */
export function renderWorkflowTree(
  name: string,
  flow: FlowNode,
  color: TreeColorize = plainTree,
): string {
  return renderFlowTree({ kind: "workflow", name, body: flow }, color);
}

/**
 * Flow tree with kind icons replaced by live status icons. Saved-workflow
 * runs carry a real workflow root; inline runs intentionally remain flat.
 */
export function renderRunTree(
  run: RunView,
  color: TreeColorize = plainTree,
): string {
  const statuses = aggregateStatuses(run);
  return renderLines(
    build(run.header.flow, "$", color),
    statuses,
    "",
    true,
    color,
  ).join("\n");
}
