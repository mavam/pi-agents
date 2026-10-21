/**
 * Messages between agents: `agent_send` submits a message to another agent
 * of the session. Like the parent's messages, it steers a working recipient,
 * which sees it at its next step, unless the sender queues it as a
 * follow-up for after the current work. The sender doesn't wait, and the
 * recipient's answer stays with the recipient; a steer can still shape the
 * answer the recipient is working on, such as its job's.
 *
 * A send is safe to repeat. Its first run binds the recipient by identity in
 * a memo of the call's tool task, so a rerun after a restart never resolves the
 * name again. Under the recipient's turn (`MessagingHub`), the send then
 * logs the message, refusing a stopped recipient in the same commit, and
 * submits it with the request ID `message:<sender>:<tool task>`, which the
 * recipient admits once. When the service starts, it submits logged
 * messages that a crash left without a submission.
 *
 * Agents reach the agent that spawned them, the others it spawned with
 * them, and the agents they spawned; the parent's agents reach each other.
 */

import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  type AgentState as DurableAgentState,
  defineExtension,
  defineTool,
  type Extension,
  type InputSubmissionDraft,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { nodeRequestId } from "./graphs.js";
import type { MessagingHub } from "./hub.js";
import { type AgentReceipt, receipt, stateOutcome } from "./receipts.js";
import {
  type AgentRecord,
  AgentsDoc,
  GraphsDoc,
  type GraphsState,
  isSpawned,
  MESSAGE_MEMORY,
  type MessageRecord,
  MessagesDoc,
} from "./records.js";
import { messageInput } from "./types.js";

export const MESSAGING_EXTENSION = "pi-agents-messaging";
export const SEND_TOOL = "agent_send";
export const STATUS_TOOL = "agent_status";

/** Tool output pi-durable passes on whole. */
export const UNBOUNDED_OUTPUT = {
  maxBytes: Number.POSITIVE_INFINITY,
  maxLines: Number.POSITIVE_INFINITY,
};

export interface MessagingOptions {
  /** Tests only: runs after the recipient is bound. */
  afterBind?: (context: Context) => Promise<void>;
  /** Tests only: runs after the message is logged and before it's
   * submitted, under the recipient's turn. */
  afterLog?: (context: Context) => Promise<void>;
}

/** The submission of a logged message. */
export function messageSubmission(
  message: Pick<MessageRecord, "id" | "text" | "mode">,
  sender: string,
): InputSubmissionDraft {
  return {
    type: "input",
    content: messageInput(sender, message.text),
    whenBusy: message.mode,
    requestId: message.id,
  };
}

/** What a send's first run decided, which reruns replay. */
type Binding = {
  id: string;
  from: string;
  sender: string;
  to: string;
  recipient: string;
  text: string;
  mode: "steer" | "followUp";
  sentAt: number;
};

function textResult(text: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError };
}

/**
 * Whom an agent can reach: the agent that spawned it and the others it
 * spawned with it, or, for the parent's agents, each other; and the agents
 * it spawned itself.
 */
function scopeOf(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  self: string,
): Set<string> {
  const scope = new Set<string>();
  const record = agents[self];
  if (!record) return scope;
  const group = graphs?.graphs[record.graph];
  if (group && isSpawned(group)) {
    scope.add(group.owner.agent);
    for (const node of group.nodes) scope.add(node.agent);
  } else
    for (const [id, other] of Object.entries(agents)) {
      const graph = graphs?.graphs[other.graph];
      if (!graph?.owner) scope.add(id);
    }
  for (const graph of Object.values(graphs?.graphs ?? {}))
    if (isSpawned(graph) && graph.owner.agent === self)
      for (const node of graph.nodes) scope.add(node.agent);
  scope.delete(self);
  return scope;
}

/** Resolve an ID within reach, or a name: an open agent, else the newest. */
function resolve(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  self: string,
  name: string,
): [string, AgentRecord] | undefined {
  const scope = scopeOf(agents, graphs, self);
  const byId = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (byId) return scope.has(name) ? [name, byId] : undefined;
  const named = Object.entries(agents)
    .filter(([id, record]) => record.name === name && scope.has(id))
    .sort(([, left], [, right]) => left.createdAt - right.createdAt);
  return named.find(([, record]) => !record.closed) ?? named.at(-1);
}

/** Whom an agent can message: what each name within reach addresses,
 * unless it's stopped, open agents first, then the newest. An older agent
 * whose name a newer one took is still addressable by ID. */
function reachable(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  self: string,
): Array<[string, AgentRecord]> {
  const scope = scopeOf(agents, graphs, self);
  const names = new Set(
    [...scope].flatMap((id) => {
      const name = agents[id]?.name;
      return name === undefined ? [] : [name];
    }),
  );
  return [...names]
    .flatMap((name) => {
      const target = resolve(agents, graphs, self, name);
      return target && !target[1].stopped ? [target] : [];
    })
    .sort(
      ([, left], [, right]) =>
        Number(left.closed) - Number(right.closed) ||
        right.createdAt - left.createdAt,
    );
}

/**
 * Whether the agent's job hasn't reached it yet: its graph still waits for
 * the agents the job needs. A message then would start it without its job.
 * Inside a commit.
 */
export async function awaitsJob(
  tx: Pick<Tx, "doc" | "task" | "submissionByRequest">,
  agentId: string,
  record: AgentRecord,
): Promise<boolean> {
  const graph = (await tx.doc(GraphsDoc)).graphs[record.graph];
  const node = graph?.nodes.find((each) => each.agent === agentId);
  if (!node) return false;
  const task = await tx.task(node.task as TaskId);
  if (!task || task.state.status === "terminal") return false;
  return (
    (await tx.submissionByRequest(
      Number(agentId) as ConversationId,
      nodeRequestId(node.task),
    )) === undefined
  );
}

/** The first run of a send: check it and bind its recipient. */
async function bind(
  args: { name: string; message: string; followUp?: boolean },
  api: ToolExecutionApi,
  context: Context,
): Promise<Binding | string> {
  const text = args.message.trim();
  if (!text) return "The message must not be empty.";
  const [state, graphs] = await Promise.all([
    api.snapshot(AgentsDoc, context),
    api.snapshot(GraphsDoc, context),
  ]);
  const agents = state?.agents ?? {};
  const from = String(api.conversationId);
  const sender = agents[from];
  if (!sender) return `${SEND_TOOL} is not available to you.`;
  const target = resolve(agents, graphs, from, args.name);
  if (!target) return `No agent named ${args.name} within your reach.`;
  const [to, recipient] = target;
  if (to === from) return "You can't message yourself.";
  return api.memo<Binding>(
    "message",
    {
      id: `message:${from}:${api.taskId}`,
      from,
      sender: sender.name,
      to,
      recipient: recipient.name,
      text,
      mode: args.followUp ? "followUp" : "steer",
      sentAt: Date.now(),
    },
    context,
  );
}

export function createMessagingExtension(
  hub: MessagingHub,
  options: MessagingOptions = {},
): Extension {
  return defineExtension({
    name: MESSAGING_EXTENSION,
    tools: [
      defineTool({
        name: STATUS_TOOL,
        description:
          "List the agents you can message, with their state and job: the agent that spawned you and the others it spawned with you, or the parent's other agents, and the agents you spawned.",
        parameters: Type.Object({}),
        replay: "safe",
        outputLimits: UNBOUNDED_OUTPUT,
        async execute(_args, api, context) {
          const [state, graphs] = await Promise.all([
            api.snapshot(AgentsDoc, context),
            api.snapshot(GraphsDoc, context),
          ]);
          const targets = reachable(
            state?.agents ?? {},
            graphs,
            String(api.conversationId),
          );
          const agents = await Promise.all(
            targets.map(async ([id, record]): Promise<AgentReceipt> => {
              const durable = (await api.snapshot(
                AgentDoc,
                Number(id) as ConversationId,
                context,
              )) as DurableAgentState | undefined;
              const model = durable?.model?.modelId;
              return {
                name: record.name,
                ...(model ? { model } : {}),
                outcome: stateOutcome(hub.state(id) ?? "idle"),
                job: record.job.trim(),
              };
            }),
          );
          const stateWord = (agent: AgentReceipt) =>
            agent.outcome === "answered" ? "idle" : agent.outcome;
          const text =
            agents.length === 0
              ? "No other agents."
              : agents
                  .map(
                    (agent) =>
                      `## ${agent.name} (${stateWord(agent)})\nJob:\n${agent.job}`,
                  )
                  .join("\n\n");
          return {
            output: [{ type: "text", text }],
            details: { receipt: receipt({ agents }) },
          };
        },
      }),
      defineTool({
        name: SEND_TOOL,
        description:
          "Send a message to an agent within your reach, which agent_status lists, and return at once. The recipient's answer stays with it; to hear back, ask it to message you.",
        parameters: Type.Object({
          name: Type.String({ description: "Agent name or ID" }),
          message: Type.String({
            description:
              "What to tell the agent; it arrives as input that starts with [from <your name>]",
          }),
          followUp: Type.Optional(
            Type.Boolean({
              description:
                "Wait until the recipient's current work ends; by default, a working recipient sees the message at its next step, which can change its current answer",
            }),
          ),
        }),
        replay: "safe",
        async execute(args, api, context) {
          // A rerun replays the first run's binding.
          const bound =
            (await api.memo<Binding>("message", context)) ??
            (await bind(args, api, context));
          if (typeof bound === "string") return textResult(bound, true);
          await options.afterBind?.(context);
          const outcome = await hub.turn(bound.to, async () => {
            const logged = await api.commit(async (tx) => {
              const log = await tx.doc(MessagesDoc);
              const known = log.messages.find(
                (message) => message.id === bound.id,
              );
              if (known) return known.dropped ? "stopped" : "logged";
              const recipient = (await tx.doc(AgentsDoc)).agents[bound.to];
              if (!recipient) return "missing";
              if (recipient.stopped) return "stopped";
              if (await awaitsJob(tx, bound.to, recipient)) return "blocked";
              log.messages.push({
                id: bound.id,
                from: bound.from,
                to: bound.to,
                text: bound.text,
                mode: bound.mode,
                sentAt: bound.sentAt,
              });
              const over = log.messages.length - MESSAGE_MEMORY;
              if (over > 0) {
                log.messages.splice(0, over);
                log.dropped = (log.dropped ?? 0) + over;
              }
              return "logged";
            }, context);
            if (logged !== "logged") return logged;
            await options.afterLog?.(context);
            // Once logged, the message is submitted, also when the call is
            // cancelled meanwhile.
            const durable = withoutAbortSignal(context);
            const conversation = await api.conversation(
              Number(bound.to) as ConversationId,
              durable,
            );
            if (!conversation) return "missing";
            await conversation.submit(
              messageSubmission(bound, bound.sender),
              durable,
            );
            return "sent";
          });
          if (outcome === "missing")
            return textResult(`No agent named ${bound.recipient}.`, true);
          if (outcome === "stopped")
            return textResult(
              `${bound.recipient} was stopped and doesn't take messages from agents.`,
              true,
            );
          if (outcome === "blocked")
            return textResult(
              `${bound.recipient} waits for the agents its job needs and hasn't started; message it once it works.`,
              true,
            );
          return textResult(`Sent to ${bound.recipient}.`);
        },
      }),
    ],
  });
}
