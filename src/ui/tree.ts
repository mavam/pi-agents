/**
 * Icon-based flow trees: the human-readable rendering of the algebra. The
 * JSON/YAML form stays canonical for authoring; this is how flows are shown —
 * in the tool call display, /workflow details, and /run inspection (where
 * kind icons are replaced by live status icons).
 *
 *   ✦ agent   ≡ seq (transparent)   ⑃ par   ⑂ reduce   ⇶ map   ↺ loop
 *   ❖ workflow
 */

import {
  bodyPath,
  branchPath,
  type FlowNode,
  type ParMode,
  reducePath,
  stepPath,
} from "../model/ast.js";
import { formatPredicate } from "../model/predicate.js";
import type { NodeView, RunView } from "../run/state.js";

export const KIND_ICONS = {
  agent: "✦",
  seq: "≡",
  par: "⑃",
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

const TASK_PREVIEW_CHARS = 56;

interface DisplayNode {
  /** Line text, without the leading kind/status icon. */
  text: string;
  /** Kind icon; absent for pure grouping lines (multi-node par branches). */
  icon?: string;
  /** Rendered before the icon (e.g. a par branch key: "bugs → "). */
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

function binding(node: FlowNode): string {
  return node.as ? ` → {${node.as}}` : "";
}

function modeText(mode: ParMode | undefined): string {
  if (mode === undefined || mode === "all") return "all";
  if (mode === "any") return "any";
  return `quorum ${mode.quorum}`;
}

/** Build display nodes. Seq is transparent: it yields one node per step. */
function build(node: FlowNode, path: string): DisplayNode[] {
  switch (node.kind) {
    case "agent":
      return [
        {
          icon: KIND_ICONS.agent,
          text: `${node.name}${binding(node)} · ${node.task !== undefined ? preview(node.task) : "(default task)"}`,
          path,
          children: [],
        },
      ];
    case "seq": {
      return node.steps.flatMap((step, index) =>
        build(step, stepPath(path, index)),
      );
    }
    case "par": {
      const extras = [
        node.onError === "collect" ? "collect errors" : undefined,
        node.concurrency !== undefined ? `×${node.concurrency}` : undefined,
      ].filter(Boolean);
      const children: DisplayNode[] = Object.entries(node.branches).map(
        ([key, branch]) => {
          const subs = build(branch, branchPath(path, key));
          if (subs.length === 1) {
            const only = subs[0] as DisplayNode;
            return { ...only, prefixText: `${key} → ` };
          }
          return { text: `${key}:`, children: subs };
        },
      );
      if (node.reduce) {
        children.push({
          icon: KIND_ICONS.reduce,
          text: `reduce → ${node.reduce.agent} · ${preview(node.reduce.task)}`,
          path: reducePath(path),
          children: [],
        });
      }
      return [
        {
          icon: KIND_ICONS.par,
          text: `par (${[modeText(node.mode), ...extras].join(", ")})${binding(node)}`,
          path,
          children,
        },
      ];
    }
    case "map": {
      const children = build(node.body, bodyPath(path));
      if (node.reduce) {
        children.push({
          icon: KIND_ICONS.reduce,
          text: `reduce → ${node.reduce.agent} · ${preview(node.reduce.task)}`,
          path: reducePath(path),
          children: [],
        });
      }
      return [
        {
          icon: KIND_ICONS.map,
          text: `map ${node.over}${node.concurrency !== undefined ? ` (×${node.concurrency})` : ""}${binding(node)}`,
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
          text: `loop ≤${node.max}${until}${binding(node)}`,
          path,
          children: build(node.body, bodyPath(path)),
        },
      ];
    }
    case "workflow": {
      const params = Object.entries(node.params ?? {})
        .map(([key, value]) => `${key}: ${preview(value)}`)
        .join(", ");
      return [
        {
          icon: KIND_ICONS.workflow,
          text: `${node.name}${params ? ` (${params})` : ""}${binding(node)}`,
          path,
          children: node.body ? build(node.body, bodyPath(path)) : [],
        },
      ];
    }
  }
}

/** Per-path status aggregation for the /run overlay and the live widget. */
export interface PathStatus {
  icon: string;
  status: "running" | "completed" | "failed" | "cancelled";
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
): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const connector = top ? "" : last ? "└─ " : "├─ ";
    const childPrefix = top ? "" : prefix + (last ? "   " : "│  ");
    const status = node.path ? statuses?.get(node.path) : undefined;
    const icon = statuses
      ? (status?.icon ?? STATUS_TREE_ICONS.pending)
      : node.icon;
    const detail = status?.detail ? ` [${status.detail}]` : "";
    const error = status?.error ? ` — ${preview(status.error)}` : "";
    lines.push(
      `${prefix}${connector}${node.prefixText ?? ""}${icon ? `${icon} ` : ""}${node.text}${detail}${error}`,
    );
    lines.push(...renderLines(node.children, statuses, childPrefix, false));
  });
  return lines;
}

/** Static flow tree with kind icons (definitions, tool-call previews). */
export function renderFlowTree(flow: FlowNode): string {
  return renderLines(build(flow, "$"), undefined, "", true).join("\n");
}

/** Flow tree with kind icons replaced by live status icons. */
export function renderRunTree(run: RunView): string {
  const statuses = aggregateStatuses(run);
  return renderLines(build(run.header.flow, "$"), statuses, "", true).join(
    "\n",
  );
}
