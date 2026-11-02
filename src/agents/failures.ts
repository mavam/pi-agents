/**
 * What the harness reports, as text that names what failed: the agent or
 * graph a task belongs to, and the extension or host callback whose code
 * failed. Pure functions over plain data.
 */

import { GENERATION_KIND } from "./derive.js";
import { GRAPH_TASK, NODE_TASK } from "./graphs.js";

/** A harness report as plain data; see pi-durable's `Report`. */
export interface HarnessReport {
  error: unknown;
  kind:
    | "storage_failed"
    | "task_faulted"
    | "task_interrupted"
    | "migration_failed"
    | "task_outdated"
    | "task_error"
    | "extension_error"
    | "host_error"
    | "listener_error";
  task?: { id: string; kind: string; conversation: string };
  /** The conversation whose agent was resolved, outside a task. */
  conversation?: string;
  extension?: string;
  /** The failing host callback, such as `models` or `env`. */
  callback?: string;
  reason?: string;
}

const TASK_LABELS: Record<string, string> = {
  [GENERATION_KIND]: "turn",
  "pi.tool": "tool call",
  "pi.compaction": "compaction",
  [GRAPH_TASK]: "graph",
  [NODE_TASK]: "graph step",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What crashes cut off: Pi stopped too often while the work ran
 * (`restart_limit`), or while the model answered with no retry left
 * (`interrupted`). A turn ends its run, which the user can continue; a
 * tool call ends with an error the agent sees, and a compaction fails.
 */
function interruptedText(
  who: string,
  kind: string | undefined,
  reason: string | undefined,
): string {
  const cause =
    reason === "interrupted"
      ? "Pi stopped while the model answered"
      : "Pi crashed or was killed repeatedly";
  switch (kind) {
    case GENERATION_KIND:
      return `${who} failed: ${cause}. Continue it with r in /agents.`;
    case "pi.tool":
      return `${who}: ${cause} while a tool call ran, so the call failed`;
    case "pi.compaction":
      return `${who}: ${cause} while it compacted, so the compaction failed`;
    default:
      return `${who}: ${cause} while its ${kind ? (TASK_LABELS[kind] ?? kind) : "work"} ran, so it failed`;
  }
}

/**
 * The report's text, or undefined when another notice covers it: a failed
 * session reports once, through the host's recovery. `subject` names the
 * agent or graph of a conversation or task, such as `Agent api`.
 */
export function describeReport(
  report: HarnessReport,
  subject: (where: {
    conversation?: string;
    task?: string;
  }) => string | undefined,
): string | undefined {
  const error = errorText(report.error);
  const task = report.task;
  const who =
    subject({
      ...((task?.conversation ?? report.conversation) !== undefined
        ? { conversation: task?.conversation ?? report.conversation }
        : {}),
      ...(task ? { task: task.id } : {}),
    }) ?? "An agent";
  const what = task ? (TASK_LABELS[task.kind] ?? task.kind) : "work";
  const extension = report.extension ? ` (${report.extension})` : "";
  switch (report.kind) {
    case "storage_failed":
      return undefined;
    case "task_interrupted":
      return interruptedText(who, task?.kind, report.reason);
    case "task_faulted":
      return report.reason === "restart_limit"
        ? `${who}: Pi crashed or was killed repeatedly while its ${what} ran, so it failed`
        : `${who}: its ${what}${extension} failed: ${error}`;
    case "migration_failed":
    case "task_outdated":
      return `${who}: this pi-agents version can't run its ${what}${extension}: ${error}`;
    case "task_error":
      return `${who}: its ${what}${extension} reported: ${error}`;
    case "extension_error":
      return report.task || report.conversation
        ? `${who}: ${report.extension ?? "an extension"} failed: ${error}`
        : `${report.extension ?? "An extension"} failed: ${error}`;
    case "host_error":
      return report.task
        ? `${who}: Pi's ${report.callback ?? "host"} failed: ${error}`
        : `Pi's ${report.callback ?? "host"} failed for agents: ${error}`;
    default:
      return error;
  }
}
