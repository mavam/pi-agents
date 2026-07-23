/**
 * Icon-based flow trees: the human-readable rendering of the algebra. The
 * JSON/YAML form stays canonical for authoring; this is how flows are shown —
 * in the tool call display, /workflow details, and /run inspection (where
 * kind icons are replaced by live status icons).
 *
 *   ✦ agent   ≡ sequence (transparent)   ⑃ parallel   ⑂ reduce   ⇶ map   ↺ loop
 *   ❖ workflow
 */

import {
  ADHOC_LABEL,
  bodyPath,
  branchPath,
  type FlowNode,
  type ParMode,
  reducePath,
  stepPath,
} from "../model/ast.js";
import { parseTemplate } from "../model/interpolate.js";
import { formatPredicate } from "../model/predicate.js";
import type { NodeView, RunView } from "../run/state.js";

export const KIND_ICONS = {
  agent: "✦",
  sequence: "≡",
  parallel: "⑃",
  reduce: "⑂",
  map: "⇶",
  loop: "↺",
  workflow: "❖",
} as const;

export const STATUS_TREE_ICONS = {
  pending: "○",
  running: "◉",
  completed: "●",
  failed: "✗",
  cancelled: "⊘",
} as const;

const STATUS_TREE_COLORS: Record<
  keyof typeof STATUS_TREE_ICONS,
  Parameters<TreeColorize>[0]
> = {
  pending: "dim",
  running: "accent",
  completed: "success",
  failed: "error",
  cancelled: "dim",
};

const TASK_PREVIEW_CHARS = 56;

/**
 * Dataflow-first coloring: `{references}` in accent, prose and connectors
 * dim, kind glyphs muted, status icons by outcome (green when completed).
 * The identity default keeps plain contexts (markdown code fences, tests)
 * byte-identical.
 */
export type TreeColorize = (
  color: "accent" | "dim" | "muted" | "success" | "error",
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

/** Per-path status aggregation for the /run overlay and the live widget. */
export interface PathStatus {
  icon: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Node kind at this path (agent/reduce paths carry the work). */
  kind: NodeView["kind"];
  completed: number;
  total: number;
  /** e.g. "3/5" for map items, "#2" for loop iterations. */
  detail?: string;
  error?: string;
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
      icon: STATUS_TREE_ICONS[status],
      status,
      kind: (nodes[0] as NodeView).kind,
      completed: counts.completed,
      total: nodes.length,
      detail,
      error,
    });
  }
  return result;
}

function renderLines(
  nodes: DisplayNode[],
  statuses: Map<string, PathStatus> | undefined,
  prefix: string,
  top: boolean,
  color: TreeColorize,
): string[] {
  // Identity colorizers (markdown fences, tests) render plainly.
  const coloring = color("dim", "·") !== "·";
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const connector = top ? "" : last ? "└─ " : "├─ ";
    const childPrefix = top ? "" : prefix + (last ? "   " : "│  ");
    const status = node.path ? statuses?.get(node.path) : undefined;
    // Static trees mute the kind glyphs. Status overlays keep the kind
    // glyph so fork/join/map structure stays readable mid-run and encode
    // the outcome in its color (matching the run rows and the live
    // widget); plain contexts (markdown fences) have no color to carry
    // state, so they pair the glyph with a status icon instead.
    let icon: string | undefined;
    if (statuses) {
      const tint = STATUS_TREE_COLORS[status?.status ?? "pending"];
      const statusGlyph = status?.icon ?? STATUS_TREE_ICONS.pending;
      icon = coloring
        ? color(tint, node.icon ?? statusGlyph)
        : [statusGlyph, node.icon].filter(Boolean).join(" ");
    } else if (node.icon !== undefined) {
      icon = color("muted", node.icon);
    }
    const detail = status?.detail ? ` [${status.detail}]` : "";
    const error = status?.error ? ` — ${preview(status.error)}` : "";
    const skeleton = `${prefix}${connector}`;
    lines.push(
      `${skeleton ? color("dim", skeleton) : ""}${node.prefixText ?? ""}${icon ? `${icon} ` : ""}${node.text}${detail}${error}`,
    );
    lines.push(
      ...renderLines(node.children, statuses, childPrefix, false, color),
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

/** Flow tree with kind icons replaced by live status icons. */
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
