/**
 * The agent abstraction: a durable, named conversation whose result is its
 * last assistant message. An agent starts with a *job*: self-contained
 * instructions for its initial work. pi-durable's tasks are something else:
 * the durable units of work, such as a turn, a tool call, or a graph. These types are the frontend's whole view of
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
  | { kind: "failed"; reason: string; detail?: string };

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
  /** The agent waits for agents it spawned: their graph, and progress. */
  spawning?: { graph: string; done: number; total: number };
}

/**
 * Why work that keeps an agent or graph busy doesn't run: `crashed` when
 * it was cut off by crashes too often in a row and waits for a retry,
 * `incompatible` when this version of pi-agents can't run it.
 */
export type Stall = "crashed" | "incompatible";

export interface AgentInfo {
  id: string;
  name: string;
  profile?: string;
  /** The instructions the agent was started with. */
  job: string;
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
  /** The entry that answered the agent's job, once one did. The latest
   * result answers the job only while it is this entry. */
  jobAnswer?: number;
  /** The graph this agent belongs to, by graph ID. */
  graph?: string;
  /** Whether the agent may spawn agents of its own. */
  spawn?: boolean;
  /** The agent that spawned this one, by agent ID; absent for the
   * parent's agents. */
  owner?: string;
  /** An answer waits for delivery to the parent, which is still busy. */
  queued?: boolean;
  /** Its work can't run: it crashed too often in a row and waits for a
   * retry, or this version of pi-agents can't run it. */
  stalled?: Stall;
  /** Why the latest compaction failed; stays until a compaction succeeds.
   * The agent keeps working, but its context may overflow. */
  compactionFailure?: string;
}

/** Where a message between agents is: waiting in the recipient's queue,
 * in its conversation, or dropped from the queue by an interrupt or stop. */
export type MessageStatus = "queued" | "delivered" | "dropped";

export interface MessageInfo {
  id: string;
  /** Sender and recipient, by agent ID and name. */
  from: { id: string; name: string };
  to: { id: string; name: string };
  text: string;
  sentAt: number;
  status: MessageStatus;
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

/** How one agent of a graph ended its job. `interrupted`: the agent itself
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
  /** Set once the agent's job ended. */
  outcome?: NodeOutcome;
}

export interface GraphInfo {
  id: string;
  name: string;
  policy: GraphPolicy;
  /** `working` until every agent ended its job; then derived from the
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
  /** Summed over the graph's agents and the agents they spawned. */
  usage: AgentUsage;
  /** The agent that spawned this graph, by agent ID. */
  owner?: string;
  /** The graph's result waits for delivery to the parent. */
  queued?: boolean;
  /** One agent the parent started on its own: shown as the agent. */
  single?: boolean;
  /** Withdrawn with the work that needed it; its result reaches nobody. */
  cancelled?: boolean;
  /** The graph's own work can't run (see `AgentInfo.stalled`). */
  stalled?: Stall;
}

/** How many agents one spawn starts. */
export const GRAPH_SIZE = { min: 1, max: 12 } as const;

/** How `agent_spawn` takes its agents, in full for its error; the
 * schema shows it more briefly. */
const SPAWN_SHAPE =
  'Arguments are always an agents array, also for a single agent: {"agents": [{"name": "lead", "job": "...", "spawn": true}]}. Each agent\'s fields, such as job, name, model, after, and spawn, go in its own entry; only the group\'s name and failFast sit beside agents.';

/** The arguments of `agent_spawn` beside `agents`. */
const GROUP_FIELDS = new Set(["name", "agents", "failFast"]);

/** Reject `agent_spawn` arguments that put an agent's fields beside
 * `agents`, with how to write them instead. Validation reports what else
 * is wrong. */
export function checkSpawnShape(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const misplaced = Object.keys(args).filter((key) => !GROUP_FIELDS.has(key));
  if (misplaced.length > 0)
    throw new AgentError(
      `Move ${misplaced.join(", ")} into an entry of agents. ${SPAWN_SHAPE}`,
    );
  return args;
}

/** How deep agents nest: the parent's agents are at depth 1, and an agent
 * at the deepest level can't spawn. */
export const MAX_DEPTH = 3;

export interface GraphAgentSpec extends SpawnSpec {
  /** Names of agents of the same graph whose results this agent needs. */
  after?: string[];
}

export interface GraphSpec {
  name?: string;
  failFast?: boolean;
  agents: GraphAgentSpec[];
}

/** An agent or a graph by its immutable ID. */
export interface TargetRef {
  kind: "agent" | "graph";
  id: string;
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
  /** Self-contained instructions for the agent's initial work. */
  job: string;
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
  /** Whether the agent may spawn agents of its own. */
  spawn?: boolean;
}

/** What a spawning agent asks for one of its agents. */
export interface HelperRequest {
  job: string;
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  /** Skills to inline instead of the skill catalog. */
  skills?: string[];
  /** Whether the agent may spawn agents of its own. */
  spawn?: boolean;
}

/** Settings a helper inherits from the agent that starts it. */
export interface HelperDefaults {
  cwd: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
}

/**
 * Resolves a helper's profile, model, and skills like the parent's spawns, with the
 * spawning agent's settings as defaults. The session host provides it;
 * it throws `AgentError` for what it can't resolve.
 */
export type HelperResolver = (
  request: HelperRequest,
  defaults: HelperDefaults,
) => Promise<SpawnSpec>;

/** How the user's input reaches a working agent: as steering, or after
 * its current work. */
export type SendMode = "auto" | "followUp";

/** How a message reaches a working agent: `steer` joins its current work
 * at its next step, `followUp` waits until that work ends, and
 * `interrupt` aborts that work first. */
export const MESSAGE_MODES = ["steer", "followUp", "interrupt"] as const;

export type MessageMode = (typeof MESSAGE_MODES)[number];

/** A send's mode from its arguments: `mode`, else calls from before it
 * existed, which set `followUp`, else `steer`. */
export function messageMode(args: {
  mode?: unknown;
  followUp?: unknown;
}): MessageMode {
  if ((MESSAGE_MODES as readonly unknown[]).includes(args.mode))
    return args.mode as MessageMode;
  return args.followUp === true ? "followUp" : "steer";
}

/** A message the parent sent: the agent, and how many queued messages
 * an interrupt dropped. */
export interface SendResult {
  agent: AgentInfo;
  dropped: number;
}

/** What a message's mode leaves queued while its recipient works. */
export function whenBusyOf(mode: MessageMode): "steer" | "followUp" {
  return mode === "followUp" ? "followUp" : "steer";
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
  outcome: RequestOutcome;
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

/** A message from another agent, as its recipient sees it. */
export function messageInput(from: string, text: string): string {
  return `[from ${from}] ${text}`;
}

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
