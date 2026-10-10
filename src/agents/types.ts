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

/** Derived from the agent's conversation; never stored. A graph's agent
 * also `waits` for its inputs or was `skipped` because none answered. */
export const AGENT_STATES = [
  "working",
  "waiting",
  "idle",
  "failed",
  "interrupted",
  "skipped",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

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
  /** The agent waits for helpers it started: its graph, and progress. */
  delegation?: { graph: string; done: number; total: number };
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
  /** When its latest run ended, from the durable task times; absent while
   * it works or before it ran. */
  endedAt?: number;
  usage: AgentUsage;
  activity: AgentActivity;
  /** Latest assistant result, once the agent answered. */
  result?: AgentResult;
  /** The latest turn ended without an answer, as this process saw it. */
  unanswered?: UnansweredTurn;
  /** The entry that answered the agent's task, once one did. The latest
   * result answers the task only while it is this entry. */
  taskAnswer?: number;
  /** The graph this agent belongs to, by graph ID. */
  graph?: string;
  /** Whether the agent can start helper agents. */
  delegates?: boolean;
  /** An answer waits for delivery to the parent, which is still busy. */
  queued?: boolean;
}

/** A turn that ended without an answer. */
export interface UnansweredTurn {
  /** Why, such as `aborted`, `model_error`, or `no_model`. */
  reason: string;
  /** The error's text, when there is one. */
  detail?: string;
  /** Whether the agent's `result` came from this turn, rather than from an
   * earlier one. */
  current: boolean;
}

/** How a graph waits for its agents: all of them, or until one fails. */
export type GraphPolicy = "allSettled" | "failFast";

/** How one agent of a graph ended its task. `interrupted`: the agent itself
 * was interrupted or stopped; `stopped`: the graph stopped it; `skipped`: it
 * never started because none of its inputs answered. */
export type NodeOutcome =
  | { kind: "answered"; result: AgentResult }
  | { kind: "failed"; reason: string }
  | { kind: "interrupted" }
  | { kind: "stopped" }
  | { kind: "skipped" };

export interface GraphNode {
  agentId: string;
  name: string;
  /** Agents whose results this agent receives, by agent ID. */
  inputs: string[];
  /** Whether no other agent of the graph needs this agent's result. */
  end: boolean;
  /** Set once the agent's task ended. */
  outcome?: NodeOutcome;
}

export interface GraphInfo {
  id: string;
  name: string;
  policy: GraphPolicy;
  /** `working` until every agent ended its task; then derived from the
   * agents nothing waits for. */
  state: AgentState;
  closed: boolean;
  /** The graph was stopped before it finished. */
  stopped: boolean;
  createdAt: number;
  /** When this process last saw the state change. */
  stateSince: number;
  /** When the graph's task ended, from the durable task times; absent while
   * it works. */
  endedAt?: number;
  /** Agents in stages: each after the agents it waits for. */
  nodes: GraphNode[];
  /** Summed over the graph's agents and the helpers they started. */
  usage: AgentUsage;
  /** The agent that started this graph as its helpers, by agent ID. */
  owner?: string;
  /** The graph's result waits for delivery to the parent. */
  queued?: boolean;
}

/** How many agents a graph has. */
export const GRAPH_SIZE = { min: 2, max: 12 } as const;

export interface GraphAgentSpec extends SpawnSpec {
  /** Names of agents of the same graph whose results this agent needs. */
  after?: string[];
}

export interface GraphSpec {
  name?: string;
  failFast?: boolean;
  agents: GraphAgentSpec[];
}

/** An agent or a graph, as a name resolves. */
export type Target =
  | { kind: "agent"; info: AgentInfo }
  | { kind: "graph"; info: GraphInfo };

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
  /** Whether the agent can start helper agents. */
  delegate?: boolean;
}

/** What a delegating agent asks for one helper. */
export interface HelperRequest {
  task: string;
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  /** Skills to inline instead of the skill catalog. */
  skills?: string[];
}

/** Settings a helper inherits from the agent that starts it. */
export interface HelperDefaults {
  cwd: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
}

/**
 * Resolves a helper's profile, model, and skills like the parent's spawns, with the
 * delegating agent's settings as defaults. The session host provides it;
 * it throws `AgentError` for what it can't resolve.
 */
export type HelperResolver = (
  request: HelperRequest,
  defaults: HelperDefaults,
) => Promise<SpawnSpec>;

export type SendMode = "auto" | "followUp";

/** What a parent call passes when it spawns, sends, or stops. */
export interface CallOptions {
  /**
   * The call's key. Repeating a call with the same key finds what its first
   * run created or did instead of acting again. Absent for the user's
   * actions, which act every time.
   */
  call?: string;
}

/** Settled parent requests that still need delivery to the parent. Several
 * requests answered by one entry deliver together. */
export interface AgentDelivery {
  kind: "agent";
  /** Stable identity, by which the parent recognizes the delivery. */
  id: string;
  agentId: string;
  name: string;
  requestIds: string[];
  outcome: Exclude<RequestOutcome, { kind: "aborted" }>;
}

/** A finished graph whose result the parent still expects. */
export interface GraphDelivery {
  kind: "graph";
  /** Stable identity, by which the parent recognizes the delivery. */
  id: string;
  graphId: string;
  name: string;
  nodes: Array<GraphNode & { outcome: NodeOutcome }>;
}

export type PendingDelivery = AgentDelivery | GraphDelivery;

/** Marks messages the user sends from the attach view, so the agent can tell
 * them from messages of the agent that started it. */
export const USER_MESSAGE_PREFIX = "[user] ";

export class AgentError extends Error {}

/** A wait that ended before its agents answered: its caller cancelled it,
 * or something needs the parent, such as the user steering. */
export class WaitInterrupted extends AgentError {
  constructor(readonly reason: "cancelled" | "attention") {
    super(
      reason === "cancelled" ? "Wait cancelled" : "Wait ended for the parent",
    );
  }
}
