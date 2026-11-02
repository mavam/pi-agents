/**
 * Stalls: live tasks that pi-durable won't run, because this version
 * doesn't have their definition or can't take their version. Such a task
 * keeps its agent busy without doing anything until the extension changes,
 * so the agent shows as stalled instead of silently working.
 *
 * The blocked reason is derived, not stored, so it comes from the harness's
 * task graph, which follows it without commits.
 */

import type {
  BlockedReason,
  Harness,
  Observation,
  TaskGraph,
} from "@earendil-works/pi-durable";
import { CONTEXT } from "./context.js";

export interface StalledTask {
  id: string;
  /** The conversation the task belongs to. */
  conversation: string;
  reason: BlockedReason;
}

export class TaskStalls {
  private observation: Observation<TaskGraph> | undefined;
  private tasks = new Map<string, StalledTask>();

  constructor(
    private readonly harness: Harness,
    /** Stalled tasks changed: those that stalled and those that no longer
     * are. */
    private readonly onChange: (changed: StalledTask[]) => void,
  ) {}

  async start(): Promise<void> {
    // Calls can come before the observation resolves; each carries the
    // whole graph, newer than the value at attachment.
    let advanced = false;
    this.observation = await this.harness.observeTaskGraph(
      {
        advance: (call) => {
          if (call.kind !== "value") return;
          advanced = true;
          this.update(call.value);
        },
        end: () => {},
      },
      CONTEXT,
    );
    if (!advanced) this.update(this.observation.value);
  }

  stop(): void {
    this.observation?.detach();
    this.observation = undefined;
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
