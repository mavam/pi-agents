/**
 * Durable tasks behind agent groups. A group is a background task owned by
 * the host conversation; it owns one turn task per agent, and each turn owns
 * its agent's conversation:
 *
 *   host conversation
 *   └─ group task (background)
 *      └─ turn task × n
 *         └─ agent conversation
 *
 * Aborting the group therefore aborts its turns and their agents bottom-up,
 * and `failFast` reaches the agents of sibling turns. Once a turn finished,
 * its agent keeps working normally when messaged.
 *
 * Versioning: both definitions are at version 1. A change to a task's input
 * or checkpoint shape bumps `version` and adds `migrate(input, checkpoint,
 * fromVersion)`, which pi-durable applies to live tasks when it next reserves
 * them; it must keep the group checkpoint's `turns`. Terminal tasks are
 * stored results and never migrate. A task whose definition is missing stays
 * blocked, not lost; stopping its group then settles it as `orphaned`.
 */

import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
  type TaskId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { GroupsDoc } from "./records.js";
import type { GroupPolicy } from "./types.js";

export const GROUPS_EXTENSION = "pi-agents-groups";
export const GROUP_TASK = "pi-agents.group";
export const TURN_TASK = "pi-agents.turn";

/** What a turn produced. A failure is the task's `failed` outcome, and a
 * turn the group aborted is `aborted`. */
export type TurnResult =
  | { kind: "answered"; entryId: number }
  /** The agent itself was interrupted or stopped. */
  | { kind: "interrupted" };

export type TurnInput = { message: string };
type TurnState = { phase: "turn" };

export type GroupInput = { policy: GroupPolicy };
type GroupState = { phase: "join" } | { phase: "report"; turns: number[] };
/** Turn outcome statuses, in agent order. */
export type GroupResult = { outcomes: string[] };

/** Request ID of a turn's submission, so a rerun finds the same one. */
export function turnRequestId(turn: number): string {
  return `turn:${turn}`;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** An aborted invocation, at close or stop, leaves the outcome to the
 * scheduler: closing preserves the task, an abort mark runs `abort`. */
function rethrowUnlessAborted(signal: AbortSignal, error: unknown): void {
  if (!signal.aborted) throw error;
}

async function ownedConversation(
  turn: number,
  runtime: TaskRuntime<TurnInput, TurnState, TurnResult, object>,
  context: Context,
): Promise<ConversationId | undefined> {
  let found: ConversationId | undefined;
  await runtime.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: turn as TaskId }, 1);
    found = page.items[0]?.id;
    return undefined;
  }, context);
  return found;
}

/**
 * One message to one agent. The agent's conversation is found through the
 * ownership index and the message is submitted with a request ID derived
 * from the turn, so a turn interrupted by a restart waits for the same
 * submission instead of sending it again.
 */
export const TurnTask = defineTask<TurnInput, TurnState, TurnResult>({
  name: TURN_TASK,
  version: 1,
  initial: () => ({ phase: "turn" }),
  phases: {
    turn: async (task, runtime, context) => {
      try {
        const id = await ownedConversation(task.id, runtime, context);
        const conversation =
          id === undefined
            ? undefined
            : await runtime.conversation(id, context);
        if (!conversation) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: "agent missing" },
              },
            }),
            context,
          );
          return;
        }
        const submission = await conversation.submit(
          {
            type: "input",
            content: task.input.message,
            whenBusy: "followUp",
            requestId: turnRequestId(task.id),
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          const failed = (message: string) =>
            ({
              status: "terminal",
              outcome: { status: "failed", error: { message } },
            }) as const;
          const completed = (result: TurnResult) =>
            ({
              status: "terminal",
              outcome: { status: "completed", result },
            }) as const;
          if (settled.type !== "input") return failed("unexpected submission");
          if (settled.status === "done") {
            const entry = await tx.entry(settled.answer);
            const message = entry?.model?.[0] as AssistantMessage | undefined;
            if (message?.stopReason === "error")
              return failed(message.errorMessage ?? "error");
            if (message?.stopReason === "aborted")
              return completed({ kind: "interrupted" });
            return completed({ kind: "answered", entryId: settled.answer });
          }
          if (settled.status !== "unanswered") return undefined;
          // A direct interrupt of the agent is not a failure, so `failFast`
          // keeps its siblings working.
          if (settled.reason === "aborted")
            return completed({ kind: "interrupted" });
          return failed(textOf(settled.detail) ?? settled.reason);
        }, context);
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
});

/**
 * Waits for its turns, which the spawn commit created with it, and reports
 * their outcome statuses. The group's own record stays in the session
 * document `pi-agents.groups`.
 */
export const GroupTask = defineTask<GroupInput, GroupState, GroupResult>({
  name: GROUP_TASK,
  version: 1,
  initial: () => ({ phase: "join" }),
  phases: {
    join: async (task, runtime, context) => {
      try {
        const state = await runtime.snapshot(GroupsDoc, context);
        const turns = state?.groups[String(task.id)]?.turns;
        await runtime.commit(
          () =>
            turns === undefined
              ? {
                  status: "terminal",
                  outcome: {
                    status: "failed",
                    error: { message: "group record missing" },
                  },
                }
              : {
                  status: "waiting",
                  checkpoint: { phase: "report", turns },
                  on: turns as TaskId[],
                  policy: task.input.policy,
                },
          context,
        );
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
    report: async (task, runtime, context) => {
      try {
        const outcomes = await runtime.outcomes(
          task.state.checkpoint.turns as TaskId<TurnResult>[],
          context,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { outcomes: outcomes.map((outcome) => outcome.status) },
            },
          }),
          context,
        );
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
});

export function createGroupsExtension(): Extension {
  return defineExtension({
    name: GROUPS_EXTENSION,
    tasks: [TurnTask, GroupTask],
  });
}
