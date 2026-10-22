/**
 * Stalls: live tasks that pi-durable won't run. A task that crashes, is
 * evicted, or is reset too often in a row without progress is parked until
 * someone retries it (`restart_limit`), and a task whose definition this
 * version doesn't have or can't take is blocked until the extension changes.
 * Either keeps its agent busy without doing anything, so the agent shows as
 * stalled instead of silently working.
 *
 * The blocked reason is derived, not stored, so it comes from the harness's
 * task graph, which follows it without commits.
 */

import type { AttachedReplicatedState } from "@earendil-works/chord";
import type {
  BlockedReason,
  Harness,
  TaskGraph,
  TaskId,
} from "@earendil-works/pi-durable";
import { CONTEXT } from "./context.js";
import type { Stall } from "./types.js";

export interface StalledTask {
  id: string;
  /** The conversation the task belongs to. */
  conversation: string;
  reason: BlockedReason;
}

/** How a stall reads to the frontend: a parked task can run again. */
export function stallOf(tasks: readonly StalledTask[]): Stall | undefined {
  if (tasks.length === 0) return undefined;
  return tasks.some((task) => task.reason === "restart_limit")
    ? "crashed"
    : "incompatible";
}

export class TaskStalls {
  private state: AttachedReplicatedState<TaskGraph> | undefined;
  private unsubscribe: (() => void) | undefined;
  private tasks = new Map<string, StalledTask>();

  constructor(
    private readonly harness: Harness,
    /** Stalled tasks changed: those that stalled and those that no longer
     * are. */
    private readonly onChange: (changed: StalledTask[]) => void,
  ) {}

  async start(): Promise<void> {
    this.state = await this.harness.taskGraph(CONTEXT);
    this.update(this.state.value);
    this.unsubscribe = this.state.subscribe((value) => this.update(value));
  }

  stop(): void {
    this.unsubscribe?.();
    this.state?.dispose();
    this.state = undefined;
  }

  /** Stalled tasks of a conversation. */
  inConversation(conversation: string): StalledTask[] {
    return [...this.tasks.values()].filter(
      (task) => task.conversation === conversation,
    );
  }

  /** A stalled task by its ID. */
  task(id: string): StalledTask | undefined {
    return this.tasks.get(id);
  }

  /** Run parked tasks again; tasks blocked for other reasons stay. */
  async retry(tasks: readonly StalledTask[]): Promise<number> {
    const parked = tasks.filter((task) => task.reason === "restart_limit");
    for (const task of parked)
      await this.harness.retryTask(Number(task.id) as TaskId, CONTEXT);
    return parked.length;
  }

  private update(graph: TaskGraph): void {
    const next = new Map<string, StalledTask>();
    for (const node of Object.values(graph.tasks))
      if (node.blocked !== undefined)
        next.set(String(node.id), {
          id: String(node.id),
          conversation: String(node.conversationId),
          reason: node.blocked,
        });
    const changed = [
      ...[...next.values()].filter(
        (task) => this.tasks.get(task.id)?.reason !== task.reason,
      ),
      ...[...this.tasks.values()].filter((task) => !next.has(task.id)),
    ];
    this.tasks = next;
    if (changed.length > 0) this.onChange(changed);
  }
}
