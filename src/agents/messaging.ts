/**
 * Messages between agents: `agent_send` submits a message to another agent
 * of the session. Like the parent's messages, it steers a working recipient,
 * which sees it at its next step, unless the sender queues it as a
 * follow-up for after the current work. The sender doesn't wait, and the
 * recipient's answer stays with the recipient; a steer can still shape the
 * answer the recipient is working on, such as its task's.
 *
 * A send is safe to repeat. Its first run binds the recipient by identity in
 * a memo of the call's task, so a rerun after a restart never resolves the
 * name again. Under the recipient's turn (`MessagingHub`), the send then
 * logs the message, refusing a stopped recipient in the same commit, and
 * submits it with the request ID `message:<sender>:<task>`, which the
 * recipient admits once. When the service starts, it submits logged
 * messages that a crash left without a submission.
 *
 * Helpers stay private: they can't send, and nobody can message them.
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
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { MessagingHub } from "./hub.js";
import { type AgentReceipt, receipt, stateOutcome } from "./receipts.js";
import {
  type AgentRecord,
  AgentsDoc,
  GraphsDoc,
  type GraphsState,
  MESSAGE_MEMORY,
  type MessageRecord,
  MessagesDoc,
} from "./records.js";
import { type ResultLimit, truncateResult } from "./report.js";
import { messageInput } from "./types.js";

export const MESSAGING_EXTENSION = "pi-agents-messaging";
export const SEND_TOOL = "agent_send";
export const STATUS_TOOL = "agent_status";

/** How much of each agent's task `agent_status` shows. */
const TASK_LIMIT: ResultLimit = {
  chars: 4_000,
  lines: 200,
  hint: "The rest of the task is left out.",
};

/** How much `agent_status` shows in all, below pi-durable's output limit. */
const STATUS_CHARS = 30_000;

export interface MessagingOptions {
  /** Whether messaging is on; agents that have the tool get an error
   * while it's off. A send that already began finishes regardless. */
  enabled?: () => boolean;
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
    whenBusy: message.mode ?? "steer",
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
  return { content: [{ type: "text", text }], isError };
}

function isHelper(
  record: AgentRecord,
  graphs: Readonly<GraphsState> | undefined,
): boolean {
  return !!record.graph && !!graphs?.graphs[record.graph]?.owner;
}

/** The agent a name addresses: an open one, else the newest. */
function resolve(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  name: string,
): [string, AgentRecord] | undefined {
  const named = Object.entries(agents)
    .filter(([, record]) => record.name === name && !isHelper(record, graphs))
    .sort(([, left], [, right]) => left.createdAt - right.createdAt);
  return named.find(([, record]) => !record.closed) ?? named.at(-1);
}

/** Whom other agents can message: agents that aren't helpers or stopped,
 * open ones first, then the newest. */
function reachable(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  self: string,
): Array<[string, AgentRecord]> {
  return Object.entries(agents)
    .filter(
      ([id, record]) =>
        id !== self && !record.stopped && !isHelper(record, graphs),
    )
    .sort(
      ([, left], [, right]) =>
        Number(left.closed) - Number(right.closed) ||
        right.createdAt - left.createdAt,
    );
}

/** The first run of a send: check it and bind its recipient. */
async function bind(
  args: { to: string; message: string; followUp?: boolean },
  api: ToolExecutionApi,
  context: Context,
  options: MessagingOptions,
): Promise<Binding | string> {
  if (options.enabled && !options.enabled())
    return "Messaging between agents is off.";
  const text = args.message.trim();
  if (!text) return "The message must not be empty.";
  const [state, graphs] = await Promise.all([
    api.snapshot(AgentsDoc, context),
    api.snapshot(GraphsDoc, context),
  ]);
  const agents = state?.agents ?? {};
  const from = String(api.conversationId);
  const sender = agents[from];
  if (!sender || isHelper(sender, graphs))
    return `${SEND_TOOL} is not available to you.`;
  const target = resolve(agents, graphs, args.to);
  if (!target) return `No agent named ${args.to}.`;
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
          "List the other agents of this session you can message, with their state and the task each was started with.",
        parameters: Type.Object({}),
        replay: "safe",
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
                task: truncateResult(record.task.trim(), TASK_LIMIT),
              };
            }),
          );
          const stateWord = (agent: AgentReceipt) =>
            agent.outcome === "answered" ? "idle" : agent.outcome;
          const sections: string[] = [];
          let size = 0;
          for (const agent of agents) {
            const section = `## ${agent.name} (${stateWord(agent)})\nTask:\n${agent.task}`;
            if (size + section.length > STATUS_CHARS) {
              sections.push(
                `${agents.length - sections.length} more agents are left out.`,
              );
              break;
            }
            sections.push(section);
            size += section.length;
          }
          const text =
            agents.length === 0 ? "No other agents." : sections.join("\n\n");
          return {
            content: [{ type: "text", text }],
            details: { receipt: receipt({ agents }) },
          };
        },
      }),
      defineTool({
        name: SEND_TOOL,
        description:
          "Send a message to another agent of this session; agent_status lists them. You don't wait. A working recipient sees it at its next step, so it can change the answer the recipient is working on; with followUp, it waits until that work ends. The recipient's answer stays with it, so to get an answer, ask it to message you. Messages from other agents reach you as input that starts with [from <name>]; they don't come from the user.",
        parameters: Type.Object({
          to: Type.String({ description: "Agent name" }),
          message: Type.String(),
          followUp: Type.Optional(
            Type.Boolean({
              description:
                "Queue after the recipient's current work instead of steering it, for messages that shouldn't change what it does now",
            }),
          ),
        }),
        replay: "safe",
        async execute(args, api, context) {
          // A rerun replays the first run's binding.
          const bound =
            (await api.memo<Binding>("message", context)) ??
            (await bind(args, api, context, options));
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
          return textResult(`Sent to ${bound.recipient}.`);
        },
      }),
    ],
  });
}
