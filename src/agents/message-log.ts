/**
 * MessageLog: the messages between agents, oldest first, and the status of
 * each submission, including the messages dropped from the bounded log.
 */

import type { SubmissionRecord } from "@earendil-works/pi-durable";
import type { AgentRecord, MessageRecord } from "./records.js";
import type { AgentStore } from "./store.js";
import type { MessageInfo, MessageStatus } from "./types.js";

/** Where a message is, from its submission. */
export function messageStatus(submission: SubmissionRecord): MessageStatus {
  if (submission.status === "queued") return "queued";
  if (submission.status === "unanswered" && submission.entry === undefined)
    return "dropped";
  return "delivered";
}

export function isMessageRequest(requestId: string | undefined): boolean {
  return requestId?.startsWith("message:") === true;
}

export class MessageLog {
  /** The message log, oldest first, and each message's status. */
  private messageLog: MessageRecord[] = [];
  private readonly messageStatuses = new Map<string, MessageStatus>();
  private messagesDirty = false;
  private messagesDropped = 0;
  private readonly store: AgentStore;
  private readonly agents: () => Readonly<Record<string, AgentRecord>>;

  constructor(options: {
    store: AgentStore;
    agents: () => Readonly<Record<string, AgentRecord>>;
  }) {
    this.store = options.store;
    this.agents = options.agents;
  }

  markDirty(): void {
    this.messagesDirty = true;
  }

  isDirty(): boolean {
    return this.messagesDirty;
  }

  noteSubmission(submission: SubmissionRecord): void {
    this.messageStatuses.set(
      submission.requestId as string,
      messageStatus(submission),
    );
    this.messagesDirty = true;
  }

  /** The message log, and the status of messages this process hasn't
   * seen a submission of. */
  async load(): Promise<void> {
    this.messagesDirty = false;
    const state = await this.store.loadMessages();
    this.messageLog = structuredClone(state?.messages ?? []) as MessageRecord[];
    this.messagesDropped = state?.dropped ?? 0;
    const ids = new Set(this.messageLog.map((message) => message.id));
    for (const id of this.messageStatuses.keys())
      if (!ids.has(id)) this.messageStatuses.delete(id);
    const unknown = this.messageLog.filter(
      (message) => !this.messageStatuses.has(message.id),
    );
    if (unknown.length === 0) return;
    const found = await this.store.submissionsByRequest(unknown);
    found.forEach((submission, index) => {
      const id = unknown[index]?.id;
      if (id && submission)
        this.messageStatuses.set(id, messageStatus(submission));
    });
  }

  /** Messages between agents, oldest first. */
  list(): MessageInfo[] {
    const records = this.agents();
    return this.messageLog.flatMap((message) => {
      const from = records[message.from];
      const to = records[message.to];
      if (!from || !to) return [];
      return [
        {
          id: message.id,
          from: { id: message.from, name: from.name },
          to: { id: message.to, name: to.name },
          text: message.text,
          sentAt: message.sentAt,
          status: message.dropped
            ? "dropped"
            : (this.messageStatuses.get(message.id) ?? "queued"),
        },
      ];
    });
  }

  /** How many older messages the log dropped. */
  dropped(): number {
    return this.messagesDropped;
  }
}
