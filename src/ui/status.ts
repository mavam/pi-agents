import type { NodeStatus, RunStatus } from "../run/events.js";

/** Every lifecycle status rendered by the workflow UI. */
export type DisplayStatus = "pending" | NodeStatus | RunStatus;

export type StatusColor = "dim" | "warning" | "success" | "error";

/** Shared status language for trees, rows, widgets, tools, and notifications. */
export const STATUS_STYLES = {
  pending: { icon: "○", color: "dim" },
  running: { icon: "◉", color: "warning" },
  completed: { icon: "●", color: "success" },
  failed: { icon: "✗", color: "error" },
  cancelled: { icon: "⊘", color: "dim" },
  stopped: { icon: "⊘", color: "dim" },
} as const satisfies Record<
  DisplayStatus,
  { icon: string; color: StatusColor }
>;
