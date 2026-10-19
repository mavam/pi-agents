/**
 * What the harness reports, as text that names what failed: the agent or
 * graph a task belongs to, and the extension or host callback whose code
 * failed. Pure functions over plain data.
 */

import { GENERATION_KIND } from "./derive.js";
import { GRAPH_TASK, NODE_TASK } from "./graphs.js";

/** A harness report as plain data; see pi-durable's `ReportInfo`. */
export interface HarnessReport {
  error: unknown;
  type:
    | "session_failed"
    | "task_faulted"
    | "task_parked"
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
  switch (report.type) {
    case "session_failed":
      return undefined;
    case "task_parked":
      return `${who} stalled: Pi crashed or was killed repeatedly while its ${what} ran. Retry it with r in /agents, or stop it.`;
    case "task_faulted":
      return report.reason === "restart_limit"
        ? `${who}: stopping its ${what} was cut off by crashes too often, so it failed`
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
