/**
 * The agent abstraction: a durable, named conversation whose result is its
 * last assistant message. These types are the frontend's whole view of
 * agents; nothing outside `src/host` and `src/agents` sees pi-durable.
 */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/** Derived from the agent's conversation; never stored. */
export type AgentState = "working" | "idle" | "failed" | "interrupted";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export function formatModelRef(model: ModelRef | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : "default";
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const EMPTY_USAGE: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/** The text of an assistant message and how it ended. */
export interface AgentResult {
  agentId: string;
  name: string;
  /** Assistant entry that carries the result; identifies it durably. */
  entryId: number;
  text: string;
  /** pi-ai stop reason: `stop`, `length`, `toolUse`, `error`, or `aborted`. */
  stopReason: string;
  errorMessage?: string;
  /** When the message was produced. */
  at?: number;
}

/** What a settled parent request produced. */
export type RequestOutcome =
  | { kind: "answered"; result: AgentResult }
  | { kind: "aborted" }
  | { kind: "failed"; reason: string };

/** Live activity of a working agent. */
export interface AgentActivity {
  /** Running tool name. */
  tool?: string;
  /** Latest reasoning headline from the streaming answer. */
  summary?: string;
  /** Pending retry after a provider error. */
  retry?: string;
  /** A compaction is running. */
  compacting?: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  profile?: string;
  task: string;
  cwd: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  tools?: string[];
  state: AgentState;
  closed: boolean;
  createdAt: number;
  /** When this process last saw the state change. */
  stateSince: number;
  /** When this process last saw any progress. */
  lastActivityAt: number;
  usage: AgentUsage;
  activity: AgentActivity;
  /** Latest assistant result, once the agent answered. */
  result?: AgentResult;
  /** The group this agent belongs to, by group ID. */
  group?: string;
}

/** How a group waits for its agents: all of them, or until one fails. */
export type GroupPolicy = "allSettled" | "failFast";

/** How one agent of a group ended its task. `interrupted`: the agent itself
 * was interrupted or stopped; `stopped`: the group stopped it. */
export type MemberOutcome =
  | { kind: "answered"; result: AgentResult }
  | { kind: "failed"; reason: string }
  | { kind: "interrupted" }
  | { kind: "stopped" };

export interface GroupMember {
  agentId: string;
  name: string;
  /** Set once the agent's task ended. */
  outcome?: MemberOutcome;
}

export interface GroupInfo {
  id: string;
  name: string;
  policy: GroupPolicy;
  /** `working` until every agent ended its task; then derived from them. */
  state: AgentState;
  closed: boolean;
  /** The group was stopped before it finished. */
  stopped: boolean;
  createdAt: number;
  /** When this process last saw the state change. */
  stateSince: number;
  members: GroupMember[];
  /** Summed over the group's agents. */
  usage: AgentUsage;
}

/** How many agents a group has. */
export const GROUP_SIZE = { min: 2, max: 8 } as const;

export interface GroupSpec {
  name?: string;
  failFast?: boolean;
  agents: SpawnSpec[];
}

/** An agent or a group, as a name resolves. */
export type Target =
  | { kind: "agent"; info: AgentInfo }
  | { kind: "group"; info: GroupInfo };

/** A live task of the agent host, for diagnostics and tests. */
export interface TaskNode {
  id: string;
  kind: string;
  /** Owning task; absent for a task its conversation owns. */
  owner?: string;
  background: boolean;
  status: string;
  /** Conversations, and thus agents, the task owns. */
  conversations: string[];
}

export interface SpawnSpec {
  task: string;
  name?: string;
  profile?: string;
  cwd: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  /** Tool allowlist; absent selects the defaults. */
  tools?: string[];
  /** Extra system prompt text, such as a profile body and its skills. */
  instructions?: string;
  /** Whether the agent sees the ambient skill catalog. */
  ambientSkills?: boolean;
}

export type SendMode = "auto" | "followUp";

/** Settled parent requests that still need delivery to the parent. Several
 * requests answered by one entry deliver together. */
export interface AgentDelivery {
  kind: "agent";
  agentId: string;
  name: string;
  requestIds: string[];
  outcome: Exclude<RequestOutcome, { kind: "aborted" }>;
}

/** A finished group whose result the parent still expects. */
export interface GroupDelivery {
  kind: "group";
  groupId: string;
  name: string;
  members: Array<GroupMember & { outcome: MemberOutcome }>;
}

export type PendingDelivery = AgentDelivery | GroupDelivery;

/** Marks messages the user sends from the attach view, so the agent can tell
 * them from messages of the agent that started it. */
export const USER_MESSAGE_PREFIX = "[user] ";

export class AgentError extends Error {}
