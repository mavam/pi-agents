/**
 * Deterministic Mermaid flowchart rendering of a flow tree: counter-based
 * node ids, branch keys visited in sorted order, no random elements — the
 * same flow always yields the same diagram.
 */

import { ADHOC_LABEL, type FlowNode, type ParMode } from "../model/ast.js";
import { formatPredicate } from "../model/predicate.js";

function escapeLabel(text: string): string {
  return text.replaceAll('"', "'").replaceAll("\n", " ").slice(0, 60);
}

/** Edge labels additionally may not contain `|`, Mermaid's label delimiter. */
function escapeEdgeLabel(text: string): string {
  return escapeLabel(text).replaceAll("|", "∣");
}

function modeLabel(mode: ParMode | undefined): string {
  if (mode === undefined || mode === "all") return "all";
  if (mode === "any") return "any";
  return `quorum ${mode.quorum}`;
}

export function toMermaid(flow: FlowNode): string {
  const lines: string[] = ["flowchart TD"];
  let counter = 0;
  const nextId = (): string => `n${counter++}`;

  /** Emit a subtree; returns its entry and exit node ids. */
  const visit = (node: FlowNode): { entry: string; exit: string } => {
    switch (node.kind) {
      case "agent": {
        const id = nextId();
        lines.push(
          `  ${id}["${escapeLabel(node.label ?? node.name ?? ADHOC_LABEL)}"]`,
        );
        return { entry: id, exit: id };
      }
      case "sequence": {
        let entry: string | undefined;
        let previous: string | undefined;
        for (const step of node.steps) {
          const child = visit(step);
          if (!entry) entry = child.entry;
          if (previous) lines.push(`  ${previous} --> ${child.entry}`);
          previous = child.exit;
        }
        const id = entry ?? nextId();
        return { entry: id, exit: previous ?? id };
      }
      case "parallel": {
        const fork = nextId();
        lines.push(`  ${fork}(("parallel"))`);
        const join = nextId();
        lines.push(`  ${join}(("${modeLabel(node.mode)}"))`);
        for (const key of Object.keys(node.branches).sort()) {
          const child = visit(node.branches[key] as FlowNode);
          lines.push(`  ${fork} -->|${escapeLabel(key)}| ${child.entry}`);
          lines.push(`  ${child.exit} --> ${join}`);
        }
        let exit = join;
        if (node.reduce) {
          const reduce = nextId();
          lines.push(
            `  ${reduce}["reduce: ${escapeLabel(node.reduce.agent ?? ADHOC_LABEL)}"]`,
          );
          lines.push(`  ${join} --> ${reduce}`);
          exit = reduce;
        }
        return { entry: fork, exit };
      }
      case "map": {
        const fork = nextId();
        lines.push(`  ${fork}{{"map ${escapeLabel(node.over)}"}}`);
        const body = visit(node.body);
        lines.push(`  ${fork} -->|per item| ${body.entry}`);
        const join = nextId();
        lines.push(`  ${join}(("collect"))`);
        lines.push(`  ${body.exit} --> ${join}`);
        let exit = join;
        if (node.reduce) {
          const reduce = nextId();
          lines.push(
            `  ${reduce}["reduce: ${escapeLabel(node.reduce.agent ?? ADHOC_LABEL)}"]`,
          );
          lines.push(`  ${join} --> ${reduce}`);
          exit = reduce;
        }
        return { entry: fork, exit };
      }
      case "loop": {
        const head = nextId();
        const until = node.until ? ` until ${formatPredicate(node.until)}` : "";
        lines.push(`  ${head}{"loop ≤${node.max}${escapeLabel(until)}"}`);
        const body = visit(node.body);
        lines.push(`  ${head} --> ${body.entry}`);
        lines.push(`  ${body.exit} -.->|repeat| ${head}`);
        return { entry: head, exit: head };
      }
      case "switch": {
        const head = nextId();
        lines.push(`  ${head}{"switch ${escapeLabel(node.on)}"}`);
        const join = nextId();
        lines.push(`  ${join}(("·"))`);
        for (const arm of node.cases) {
          const child = visit(arm.then);
          lines.push(
            `  ${head} -->|${escapeEdgeLabel(`when ${formatPredicate(arm.when)}`)}| ${child.entry}`,
          );
          lines.push(`  ${child.exit} --> ${join}`);
        }
        const fallback = visit(node.else);
        lines.push(`  ${head} -->|else| ${fallback.entry}`);
        lines.push(`  ${fallback.exit} --> ${join}`);
        return { entry: head, exit: join };
      }
      case "value": {
        const id = nextId();
        lines.push(`  ${id}[/"${escapeLabel(node.label ?? "value")}"/]`);
        return { entry: id, exit: id };
      }
      case "workflow": {
        const id = nextId();
        lines.push(
          `  subgraph ${id}_wf["workflow: ${escapeLabel(node.name)}"]`,
        );
        const body = node.body ? visit(node.body) : undefined;
        lines.push("  end");
        if (body) return { entry: body.entry, exit: body.exit };
        lines.push(`  ${id}["${escapeLabel(node.name)}"]`);
        return { entry: id, exit: id };
      }
    }
  };

  visit(flow);
  return lines.join("\n");
}
