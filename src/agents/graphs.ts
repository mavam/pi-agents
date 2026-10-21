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
 * Groups that agents spawn have the same shape, owned in the background by
 * the spawning agent's conversation instead of the anchor.
 *
 * A node waits for the nodes whose results it needs, then sends its agent
 * its job with those results appended. Its job ends with the first final
 * answer that follows the results of the groups the agent spawned meanwhile
 * (see `obligations.ts`); an interrupted agent keeps its job until it
 * answers, unless it is stopped. Aborting the graph aborts its nodes and
 * their agents bottom-up, and `failFast` reaches the agents of sibling
 * nodes; a node that ends without its answer withdraws the groups its agent
 * spawned, which the service then stops. Once a node finished, its agent
 * keeps working normally when messaged.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type TaskId,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import {
  coveringAnswer,
  covers,
  obligationsOf,
  scanStart,
} from "./obligations.js";
import {
  AgentsDoc,
  GraphsDoc,
  type GraphsState,
  isSpawned,
} from "./records.js";
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
  | { phase: "run"; inputs: number[] }
  /** The agent got its job at entry `since` but hasn't settled it: it was
   * interrupted, or answered before results of its groups arrived. */
  | { phase: "settle"; agent: number; since: number }
  /** The agent's job failed in the run of input `submission`; the groups
   * that run spawned stop first. */
  | { phase: "fail"; agent: number; reason: string; submission?: number };

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
 * The agent's job with its inputs' results appended, or undefined when no
 * input answered. Built from stored records only, so a rerun builds the same
 * message.
 */
async function composeMessage(
  job: string,
  inputs: number[],
  runtime: Runtime,
  context: Context,
): Promise<string | undefined> {
  if (inputs.length === 0) return job;
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
  return `${job}\n\n## Results of other agents\n\n${sections.join("\n\n")}`;
}

/** The agent's conversation: the one its node owns. */
async function agentOf(
  runtime: Runtime,
  context: Context,
  node: number,
): Promise<number | undefined> {
  return read(runtime, context, async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: node as TaskId }, 1);
    const id = page.items[0]?.id;
    return id === undefined ? undefined : Number(id);
  });
}

/** Mark the agent's spawned groups that haven't ended cancelled, only
 * those of the run of input `submission` if given: their results no
 * longer count, and the service stops them. Inside a commit. */
async function cancelGroups(
  tx: ReadTx,
  agent: number,
  submission?: number,
): Promise<number[]> {
  const graphs: GraphsState = await tx.doc(GraphsDoc);
  const live: number[] = [];
  for (const [id, graph] of Object.entries(graphs.graphs)) {
    if (!isSpawned(graph) || graph.owner.agent !== String(agent)) continue;
    if (graph.cancelled || graph.presented !== undefined) continue;
    if (
      submission !== undefined &&
      !(graph.owner.run ?? []).includes(submission)
    )
      continue;
    const task = await tx.task(Number(id) as TaskId);
    if (task?.state.status === "terminal") continue;
    graph.cancelled = true;
    live.push(Number(id));
  }
  return live;
}

/** The agent's entries from `from` on, oldest first. */
async function entriesFrom(
  runtime: Runtime,
  context: Context,
  agent: number,
  from: number,
): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<ReadTx["scanEntries"]>[2];
  for (;;) {
    const page = await read(runtime, context, (tx) =>
      tx.scanEntries(
        {
          conversationId: agent as ConversationId,
          minEntryId: from as EntryRecord["id"],
          order: "ascending",
        },
        128,
        cursor,
      ),
    );
    entries.push(...page.items);
    if (page.next === undefined) return entries;
    cursor = page.next;
  }
}

/** Resolve on the next change to what decides a settling node, or after a
 * while, whichever comes first. */
async function nextChange(
  runtime: Runtime,
  watches: ReadonlyArray<{ start: (listener: () => Promise<void>) => void }>,
): Promise<void> {
  runtime.signal.throwIfAborted();
  let disarm: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      for (const watch of watches) watch.start(async () => done());
      onAbort = done;
      runtime.signal.addEventListener("abort", done, { once: true });
      // The phase keeps running meanwhile, so a timer paces the recheck;
      // a restart rechecks anyway.
      disarm = runtime.setTimer(done, SETTLE_RECHECK_MS);
    });
  } finally {
    // Whatever woke it, the timer and the listener end with it.
    disarm?.();
    if (onAbort) runtime.signal.removeEventListener("abort", onAbort);
  }
  runtime.signal.throwIfAborted();
}

/** How often a settling node checks again without a change it saw. */
const SETTLE_RECHECK_MS = 5_000;

/**
 * One agent of a graph. It waits for the nodes it needs, then sends its
 * agent its job with their results appended, using a request ID derived
 * from the node, so a node interrupted by a restart waits for the same
 * submission instead of sending it again.
 */
export const NodeTask = defineTask<NodeInput, NodeState, NodeResult>({
  name: NODE_TASK,
  version: 2,
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
        const agent = await agentOf(runtime, context, task.id);
        const conversation =
          agent === undefined
            ? undefined
            : await runtime.conversation(agent as ConversationId, context);
        if (agent === undefined || !conversation) {
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
        // The stop fence: a stopped agent never gets its job. A stop that
        // lands while the job is submitted aborts it after the stop is
        // recorded, so checking again afterwards closes the gap.
        const stopped = async () =>
          (await runtime.snapshot(AgentsDoc, context))?.agents[String(agent)]
            ?.stopped === true;
        const interrupted = () =>
          runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: { kind: "interrupted" },
              },
            }),
            context,
          );
        if (await stopped()) {
          await interrupted();
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
        if (await stopped()) {
          await conversation.abort(context);
          await interrupted();
          return;
        }
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          // Only the groups of the failed run: a later run's are another
          // request's work, also when this phase reruns after a restart.
          const failed = (reason: string) =>
            ({
              status: "running",
              checkpoint: {
                phase: "fail",
                agent,
                reason,
                submission: Number(settled.id),
              },
            }) as const;
          const settle = (since: number) =>
            ({
              status: "running",
              checkpoint: { phase: "settle", agent, since },
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
            if (answer?.stopReason === "aborted") return settle(settled.entry);
            const graphs = (await tx.doc(GraphsDoc)).graphs;
            // An answer before results it was owed is an intermediate one.
            return covers(settled.answer, obligationsOf(String(agent), graphs))
              ? completed({ kind: "answered", entryId: settled.answer })
              : settle(settled.entry);
          }
          if (settled.status !== "unanswered") return undefined;
          // An interrupt corrects the agent rather than ending its job,
          // so `failFast` keeps its siblings working. A job withdrawn
          // before the agent saw it ends.
          if (settled.reason === "aborted")
            return settled.entry === undefined
              ? completed({ kind: "interrupted" })
              : settle(settled.entry);
          return failed(textOf(settled.detail) ?? settled.reason);
        }, context);
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
    settle: async (task, runtime, context) => {
      const { agent, since } = task.state.checkpoint;
      const cid = agent as ConversationId;
      try {
        for (;;) {
          const watches = (
            await Promise.all([
              runtime.watchDoc(LiveDoc, cid, context),
              runtime.watchDoc(GraphsDoc, context),
              runtime.watchDoc(AgentsDoc, context),
            ])
          ).filter((watch) => watch !== undefined);
          try {
            const [agents, graphs] = await Promise.all([
              runtime.snapshot(AgentsDoc, context),
              runtime.snapshot(GraphsDoc, context),
            ]);
            // Stopping the agent ends its job; nothing it answers counts.
            if (agents?.agents[String(agent)]?.stopped) {
              await runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: {
                    status: "completed",
                    result: { kind: "interrupted" },
                  },
                }),
                context,
              );
              return;
            }
            const obligations = obligationsOf(String(agent), graphs?.graphs);
            const entries = await entriesFrom(
              runtime,
              context,
              agent,
              scanStart(since, obligations),
            );
            const answer = coveringAnswer(entries, since, obligations);
            if (answer) {
              await runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: {
                    status: "completed",
                    result: { kind: "answered", entryId: answer.id },
                  },
                }),
                context,
              );
              return;
            }
            // The original submission already ended (or was interrupted).
            // A later run can answer this open job, but its failure belongs
            // to its own inputs, not to this job or the groups it still needs.
            await nextChange(runtime, watches);
          } finally {
            await Promise.all(watches.map((watch) => watch.stop()));
          }
        }
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
    fail: async (task, runtime, context) => {
      const { agent, reason, submission } = task.state.checkpoint;
      try {
        let live: number[] = [];
        await runtime.commit(async (tx) => {
          live = await cancelGroups(tx, agent, submission);
          return undefined;
        }, context);
        // The service stops the withdrawn groups; the job fails once they
        // ended, so nothing they do outlives the failure.
        for (const group of live)
          await runtime.waitForTask(group as TaskId, context);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "failed", error: { message: reason } },
          }),
          context,
        );
      } catch (error) {
        rethrowUnlessAborted(runtime.signal, error);
      }
    },
  },
  // Stopping the graph withdraws the groups the agent spawned, which the
  // service then stops: a task can't abort another conversation's tasks.
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      const page = await tx.scanConversations(
        { ownerTaskId: task.id as TaskId },
        1,
      );
      const agent = page.items[0]?.id;
      if (agent !== undefined) await cancelGroups(tx, Number(agent));
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
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
