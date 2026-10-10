/**
 * Durable tasks behind agent graphs. A graph is a background task owned by
 * the anchor, the conversation the host chose for the parent's graphs; it
 * owns one node task per agent, and each node owns its agent's conversation:
 *
 *   anchor
 *   └─ graph task (background)
 *      └─ node task × n
 *         └─ agent conversation
 *
 * A node waits for the nodes whose results it needs, then sends its agent
 * the task with those results appended. Aborting the graph aborts its nodes
 * and their agents bottom-up, and `failFast` reaches the agents of sibling
 * nodes. Once a node finished, its agent keeps working normally when
 * messaged.
 *
 * Versioning: both definitions are at version 1. A change to a task's input
 * or checkpoint shape bumps `version` and adds `migrate(input, checkpoint,
 * fromVersion)`, which pi-durable applies to live tasks when it next reserves
 * them; it must keep the checkpoints' task IDs. Terminal tasks are stored
 * results and never migrate. A task whose definition is missing stays
 * blocked, not lost; stopping its graph then settles it as `orphaned`.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type EntryRecord,
  type Extension,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { AgentsDoc, GraphsDoc } from "./records.js";
import type { GraphPolicy } from "./types.js";

export const GRAPHS_EXTENSION = "pi-agents-graphs";
export const GRAPH_TASK = "pi-agents.graph";
export const NODE_TASK = "pi-agents.node";

/** What a node produced. A failure is the task's `failed` outcome, and a
 * node the graph aborted is `aborted`. */
export type NodeResult =
  | { kind: "answered"; entryId: number }
  /** The agent itself was interrupted or stopped. */
  | { kind: "interrupted" }
  /** None of the node's inputs answered, so its agent never started. */
  | { kind: "skipped" };

export type NodeInput = { message: string };
type NodeState =
  | { phase: "wait" }
  /** `inputs`: node task IDs whose results the agent receives. */
  | { phase: "run"; inputs: number[] };

export type GraphInput = { policy: GraphPolicy };
type GraphState = { phase: "join" } | { phase: "report"; nodes: number[] };
/** Node outcome statuses, in spawn order. */
export type GraphResult = { outcomes: string[] };

type Runtime = TaskRuntime<NodeInput, NodeState, NodeResult, object>;
type ReadTx = Parameters<Parameters<Runtime["commit"]>[0]>[0];

/** Request ID of a node's submission, so a rerun finds the same one. */
export function nodeRequestId(node: number): string {
  return `node:${node}`;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  if (message?.role !== "assistant") return "";
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

/** An aborted invocation, at close or stop, leaves the outcome to the
 * scheduler: closing preserves the task, an abort mark runs `abort`. */
function rethrowUnlessAborted(signal: AbortSignal, error: unknown): void {
  if (!signal.aborted) throw error;
}

/** Read inside a commit that changes nothing: the runtime's only table read. */
async function read<T>(
  runtime: Runtime,
  context: Context,
  reader: (tx: ReadTx) => Promise<T>,
): Promise<T> {
  let value: T | undefined;
  await runtime.commit(async (tx) => {
    value = await reader(tx);
    return undefined;
  }, context);
  return value as T;
}

/** Why an input gave no answer, for the agent that needed it. */
function missingReason(outcome: TaskOutcome<JsonValue>): string {
  switch (outcome.status) {
    case "completed": {
      const result = outcome.result as NodeResult;
      return result.kind === "skipped" ? "skipped" : "interrupted";
    }
    case "failed":
      return `failed: ${outcome.error.message}`;
    case "aborted":
      return "stopped";
    case "orphaned":
      return `failed: ${outcome.reason}`;
    default:
      return `failed: ${outcome.error.message}`;
  }
}

/**
 * The agent's task with its inputs' results appended, or undefined when no
 * input answered. Built from stored records only, so a rerun builds the same
 * message.
 */
async function composeMessage(
  task: string,
  inputs: number[],
  runtime: Runtime,
  context: Context,
): Promise<string | undefined> {
  if (inputs.length === 0) return task;
  const outcomes = await runtime.outcomes(inputs as TaskId[], context);
  const [graphs, agents] = await Promise.all([
    runtime.snapshot(GraphsDoc, context),
    runtime.snapshot(AgentsDoc, context),
  ]);
  const nameOf = (node: number): string => {
    for (const graph of Object.values(graphs?.graphs ?? {})) {
      const found = graph.nodes.find((each) => each.task === node);
      if (found) return agents?.agents[found.agent]?.name ?? found.agent;
    }
    return `#${node}`;
  };
  let answered = 0;
  const sections: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const name = nameOf(inputs[index] as number);
    const result =
      outcome.status === "completed"
        ? (outcome.result as NodeResult)
        : undefined;
    if (result?.kind === "answered") {
      answered += 1;
      const entry = await read(runtime, context, (tx) =>
        tx.entry(result.entryId as EntryRecord["id"]),
      );
      sections.push(`### ${name}\n\n${assistantText(entry) || "(empty)"}`);
    } else {
      sections.push(
        `### ${name}\n\n(No result: ${missingReason(outcome as TaskOutcome<JsonValue>)}.)`,
      );
    }
  }
  if (answered === 0) return undefined;
  return `${task}\n\n## Results of other agents\n\n${sections.join("\n\n")}`;
}

/**
 * One agent of a graph. It waits for the nodes it needs, then sends its
 * agent the task with their results appended, using a request ID derived
 * from the node, so a node interrupted by a restart waits for the same
 * submission instead of sending it again.
 */
export const NodeTask = defineTask<NodeInput, NodeState, NodeResult>({
  name: NODE_TASK,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      try {
        const graphs = await runtime.snapshot(GraphsDoc, context);
        let inputs: number[] = [];
        for (const graph of Object.values(graphs?.graphs ?? {})) {
          const node = graph.nodes.find((each) => each.task === task.id);
          if (!node) continue;
          inputs = node.after.flatMap((agent) => {
            const input = graph.nodes.find((each) => each.agent === agent);
            return input ? [input.task] : [];
          });
        }
        await runtime.commit(
          () =>
            inputs.length === 0
              ? { status: "running", checkpoint: { phase: "run", inputs } }
              : {
                  status: "waiting",
                  checkpoint: { phase: "run", inputs },
                  // Sibling nodes belong to the graph, so only `allSettled`.
                  on: inputs as TaskId[],
                  policy: "allSettled",
                },
          context,
        );
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
    run: async (task, runtime, context) => {
      try {
        const message = await composeMessage(
          task.input.message,
          task.state.checkpoint.inputs,
          runtime,
          context,
        );
        if (message === undefined) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: { kind: "skipped" } },
            }),
            context,
          );
          return;
        }
        const id = await read(runtime, context, async (tx) => {
          const page = await tx.scanConversations(
            { ownerTaskId: task.id as TaskId },
            1,
          );
          return page.items[0]?.id;
        });
        const conversation =
          id === undefined
            ? undefined
            : await runtime.conversation(id as ConversationId, context);
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
            content: message,
            whenBusy: "followUp",
            requestId: nodeRequestId(task.id),
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          const failed = (reason: string) =>
            ({
              status: "terminal",
              outcome: { status: "failed", error: { message: reason } },
            }) as const;
          const completed = (result: NodeResult) =>
            ({
              status: "terminal",
              outcome: { status: "completed", result },
            }) as const;
          if (settled.type !== "input") return failed("unexpected submission");
          if (settled.status === "done") {
            const entry = await tx.entry(settled.answer);
            const answer = entry?.model?.[0] as AssistantMessage | undefined;
            if (answer?.stopReason === "error")
              return failed(answer.errorMessage ?? "error");
            if (answer?.stopReason === "aborted")
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
 * Waits for its nodes, which the spawn commit created with it, and reports
 * their outcome statuses. The graph's own record stays in the session
 * document `pi-agents.graphs`.
 */
export const GraphTask = defineTask<GraphInput, GraphState, GraphResult>({
  name: GRAPH_TASK,
  version: 1,
  initial: () => ({ phase: "join" }),
  phases: {
    join: async (task, runtime, context) => {
      try {
        const state = await runtime.snapshot(GraphsDoc, context);
        const nodes = state?.graphs[String(task.id)]?.nodes.map(
          (node) => node.task,
        );
        await runtime.commit(
          () =>
            nodes === undefined
              ? {
                  status: "terminal",
                  outcome: {
                    status: "failed",
                    error: { message: "graph record missing" },
                  },
                }
              : {
                  status: "waiting",
                  checkpoint: { phase: "report", nodes },
                  on: nodes as TaskId[],
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
          task.state.checkpoint.nodes as TaskId<NodeResult>[],
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

export function createGraphsExtension(): Extension {
  return defineExtension({
    name: GRAPHS_EXTENSION,
    tasks: [NodeTask, GraphTask],
  });
}
