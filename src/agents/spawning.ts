/**
 * Spawning by agents: an agent that may spawn gets `agent_spawn`,
 * `agent_wait`, and `agent_stop`, the parent's tools for its own agents.
 * One `agent_spawn` call starts one group of 1 to 12 agents, with the same
 * edges as the parent's, and returns at once. The spawning conversation
 * owns the group in the background, so an interrupt corrects the agent
 * without stopping the group:
 *
 *   spawning agent's conversation
 *   ├─ pi.generation → pi.tool (agent_spawn)
 *   └─ graph task (background)
 *      └─ node task × n
 *         └─ agent conversation
 *
 * The group's result reaches its agent once: as input the service submits
 * when the group ended, or as the result of an `agent_wait` call that holds
 * it meanwhile. Until then, the agent's answers don't settle its own work
 * (see `obligations.ts`). Stopping the agent, or its work failing,
 * withdraws its groups, and the service stops them: a task can't abort
 * another conversation's tasks.
 *
 * A rerun of `agent_spawn` finds the group its call started; one of
 * `agent_wait` waits for the groups its first run chose.
 */

import type { Context } from "@earendil-works/chord";
import {
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  type AgentState as DurableAgentState,
  defineTool,
  type Extension,
  LiveDoc,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { GraphTask, NodeTask } from "./graphs.js";
import type { MessagingHub } from "./hub.js";
import { UNBOUNDED_OUTPUT } from "./messaging.js";
import { claimName, takenNames } from "./names.js";
import { type GraphReceipt, receipt } from "./receipts.js";
import {
  type AgentRecord,
  AgentsDoc,
  type GraphRecord,
  GraphsDoc,
  isSpawned,
} from "./records.js";
import { graphReport } from "./report.js";
import {
  activeHelpers,
  errorText,
  HELPER_NAME,
  helperNames,
  helpersReceipt,
  type Planned,
  plan,
  qualify,
  reportNode,
  type SpawningLimits,
  startedReceipt,
  textResult,
} from "./spawn-support.js";
import { endNodes } from "./topology.js";
import {
  AgentError,
  checkSpawnShape,
  GRAPH_SIZE,
  type GraphPolicy,
  type HelperResolver,
  isThinkingLevel,
  MAX_DEPTH,
  THINKING_LEVELS,
} from "./types.js";

export const SPAWN_TOOL = "agent_spawn";
export const WAIT_TOOL = "agent_wait";
export const STOP_TOOL = "agent_stop";
/** The tools of agents that may spawn. */
export const SPAWNING_TOOLS = [SPAWN_TOOL, WAIT_TOOL, STOP_TOOL] as const;

type Api = ToolExecutionApi;

/** What a new agent selects, by whether it may spawn. */
export type Selection = (spawn: boolean) => {
  extensions: readonly Extension[];
  tools: readonly ToolRegistration[];
};

export interface SpawningOptions {
  resolve: HelperResolver;
  limits: SpawningLimits;
  /** The extensions and tools of a new agent besides its own tools. */
  selection: Selection;
  /** The agent waits until the returned function is called, so a cap on
   * working agents lets its agents work meanwhile. */
  pause?: (agentId: string) => () => void;
  hub: MessagingHub;
}

const agentFields = Type.Object({
  job: Type.String({
    description:
      "Self-contained instructions; the agent can't see your conversation",
  }),
  name: Type.Optional(
    Type.String({ description: "Short name, such as a role" }),
  ),
  after: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Names of agents in this call whose final messages this agent needs; it starts once they finished. Agents without after start at once",
    }),
  ),
  profile: Type.Optional(Type.String({ description: "Profile name" })),
  model: Type.Optional(Type.String({ description: "Model" })),
  thinking: Type.Optional(
    StringEnum(THINKING_LEVELS, { description: "Thinking level" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool allowlist, from your own tools",
    }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Skills to load in full instead of the skill catalog; [] for none",
    }),
  ),
  spawn: Type.Optional(
    Type.Boolean({
      description:
        "Let this agent spawn agents of its own, which report back to it. Default false",
    }),
  ),
});

const spawnParameters = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Short name for the whole group; each agent's own name goes in its entry",
    }),
  ),
  agents: Type.Array(agentFields, {
    minItems: GRAPH_SIZE.min,
    maxItems: GRAPH_SIZE.max,
    description:
      'Always an array, one entry per agent with its fields, also for a single agent: {"agents": [{"name": "lead", "job": "...", "spawn": true}]}',
  }),
  failFast: Type.Optional(
    Type.Boolean({ description: "Stop the other agents when one fails" }),
  ),
});

const waitParameters = Type.Object({
  names: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Your groups or their agents, by name or ID; omit for every group you're owed a result from",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Give up after this many seconds", minimum: 1 }),
  ),
});

const stopParameters = Type.Object({
  name: Type.String({
    description: "One of your groups, or an agent below you, by name or ID",
  }),
});

type SpawnArgs = {
  name?: string;
  agents: Array<{
    job: string;
    name?: string;
    after?: string[];
    profile?: string;
    model?: string;
    thinking?: string;
    tools?: string[];
    skills?: string[];
    spawn?: boolean;
  }>;
  failFast?: boolean;
};

/** The spawner, if it may spawn: its record and depth. */
function spawner(
  agents: Readonly<Record<string, AgentRecord>> | undefined,
  id: string,
): { record: AgentRecord; depth: number } | string {
  const record = agents?.[id];
  if (!record?.spawn) return `${SPAWN_TOOL} is not available to you.`;
  if (record.stopped) return "You were stopped and can't spawn agents.";
  const depth = record.depth;
  if (depth >= MAX_DEPTH)
    return `Agents at depth ${MAX_DEPTH} can't spawn agents.`;
  return { record, depth };
}

/** The group this call already started, if a rerun finds one. */
function startedBy(
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
  tool: number,
): string | undefined {
  return Object.entries(graphs ?? {}).find(
    ([, graph]) => isSpawned(graph) && graph.owner.tool === tool,
  )?.[0];
}

/** The newest entry of the agent: the tool call's own assistant entry. */
async function newestEntry(
  tx: Parameters<Parameters<Api["commit"]>[0]>[0],
  api: Api,
): Promise<number> {
  const page = await tx.scanEntries(
    { conversationId: api.conversationId, order: "descending" },
    1,
  );
  return Number(page.items[0]?.id ?? 0);
}

/** Start the group in one commit; an error string when a limit says no. */
async function start(
  api: Api,
  context: Context,
  args: SpawnArgs,
  owner: { id: string; record: AgentRecord; depth: number },
  planned: { helpers: Planned[]; inputs: number[][] },
  options: SpawningOptions,
): Promise<{ graph: string } | { error: string }> {
  const { limits } = options;
  return api.commit(async (tx) => {
    const graphsDoc = await tx.doc(GraphsDoc);
    const existing = startedBy(graphsDoc.graphs, api.taskId);
    if (existing) return { graph: existing };
    const agentsDoc = await tx.doc(AgentsDoc);
    // The stop fence: a stopped agent starts nothing.
    if (agentsDoc.agents[owner.id]?.stopped)
      return { error: "You were stopped and can't spawn agents." };
    const started = Object.values(graphsDoc.graphs)
      .filter((graph) => graph.owner?.agent === owner.id)
      .reduce((sum, graph) => sum + graph.nodes.length, 0);
    const count = planned.helpers.length;
    if (started + count > limits.perAgent)
      return {
        error: `You can spawn ${limits.perAgent} agents in total and spawned ${started}, so ${count} more is too many.`,
      };
    const active = await activeHelpers(tx, graphsDoc.graphs);
    if (active + count > limits.active)
      return {
        error: `At most ${limits.active} spawned agents can work at once in this session and ${active} do. Spawn fewer, or wait for yours to finish.`,
      };
    const taken = takenNames(agentsDoc, graphsDoc);
    const names = planned.helpers.map((helper) =>
      claimName(
        undefined,
        qualify(owner.record.name, helper.name),
        taken,
        "agent",
      ),
    );
    const single = planned.helpers.length === 1;
    const requested = args.name?.trim();
    const graphName = single
      ? (names[0] as string)
      : claimName(
          undefined,
          qualify(
            owner.record.name,
            requested && HELPER_NAME.test(requested) ? requested : "group",
          ),
          taken,
          "graph",
        );
    const policy: GraphPolicy = args.failFast ? "failFast" : "allSettled";
    const since = await newestEntry(tx, api);
    // The run that spawns decides the group's fate if it fails.
    const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs;
    const graph = await tx.createTask(
      GraphTask,
      { policy },
      { ownership: { kind: "conversation" }, background: true },
    );
    const agents: string[] = [];
    const tasks: number[] = [];
    for (const helper of planned.helpers) {
      const task = await tx.createTask(
        NodeTask,
        { message: helper.spec.job.trim() },
        { ownership: { kind: "task", taskId: graph } },
      );
      const conversation = await tx.createConversation({
        ownership: { kind: "task", taskId: task },
      });
      const { spec } = helper;
      const extra = options.selection(spec.spawn === true);
      // Everything explicit: the copy of the spawning agent's settings must
      // not reach the new agent.
      await configure(tx, conversation.id, {
        extensions: extra.extensions,
        tools: [...helper.tools, ...extra.tools],
        modelTools: null,
        cwd: spec.cwd,
        model: spec.model ?? null,
        thinkingLevel: spec.thinking ?? null,
        instructions: spec.instructions ?? null,
      });
      agents.push(String(conversation.id));
      tasks.push(task);
    }
    const createdAt = Date.now();
    planned.helpers.forEach((helper, index) => {
      agentsDoc.agents[agents[index] as string] = {
        name: names[index] as string,
        profile: helper.spec.profile ?? null,
        job: helper.spec.job.trim(),
        createdAt,
        closed: false,
        ambientSkills: helper.spec.ambientSkills ?? true,
        ...(owner.record.extensionState
          ? { extensionState: structuredClone(owner.record.extensionState) }
          : {}),
        nextRequest: 1,
        requests: {},
        delivered: [],
        graph: String(graph),
        depth: owner.depth + 1,
        ...(helper.spec.spawn ? { spawn: true } : {}),
      };
    });
    graphsDoc.graphs[String(graph)] = {
      name: graphName,
      policy,
      createdAt,
      nodes: planned.helpers.map((_helper, index) => ({
        agent: agents[index] as string,
        task: tasks[index] as number,
        after: (planned.inputs[index] ?? []).map(
          (input) => agents[input] as string,
        ),
      })),
      closed: false,
      // The result goes to the spawning agent, not the parent.
      pending: false,
      ...(single ? { single: true as const } : {}),
      owner: {
        agent: owner.id,
        tool: api.taskId,
        since,
        ...(run === undefined ? {} : { run: run.map(Number) }),
      },
    };
    return { graph: String(graph) };
  }, context);
}

/** The group's result as text for its agent, its receipt, and whether it
 * finished, from stored records only. */
export async function groupResult(
  api: Pick<Api, "snapshot" | "getTask" | "commit">,
  context: Context,
  graphId: string,
): Promise<{ text: string; receipt?: GraphReceipt; finished: boolean }> {
  const [graphs, agents] = await Promise.all([
    api.snapshot(GraphsDoc, context),
    api.snapshot(AgentsDoc, context),
  ]);
  const graph = graphs?.graphs[graphId];
  if (!graph) return { text: "The group is missing.", finished: true };
  const ends = new Set(
    endNodes(
      graph.nodes.map((node) => ({ key: node.agent, inputs: node.after })),
    ),
  );
  const names = helperNames(graph, agents?.agents);
  const nodes = await Promise.all(
    graph.nodes.map((node) =>
      reportNode(
        api as Api,
        context,
        names(node.agent),
        ends.has(node.agent),
        node.task,
      ),
    ),
  );
  const settled = await api.getTask(Number(graphId) as TaskId, context);
  const finished = settled?.state.status === "terminal";
  const stopped =
    graph.stopped === true ||
    (settled?.state.status === "terminal" &&
      settled.state.outcome.status === "aborted");
  const label = names(graph.nodes[0]?.agent ?? "");
  const text = graphReport(graph.single ? label : graph.name, nodes, {
    single: graph.single === true,
  });
  return {
    text: stopped ? `Stopped before it finished.\n\n${text}` : text,
    receipt: await helpersReceipt(
      api as Api,
      context,
      graph,
      names,
      nodes,
      stopped,
    ),
    finished,
  };
}

async function spawnExecute(
  args: SpawnArgs,
  api: Api,
  context: Context,
  options: SpawningOptions,
): Promise<ToolExecutionResult> {
  const [agents, graphs] = await Promise.all([
    api.snapshot(AgentsDoc, context),
    api.snapshot(GraphsDoc, context),
  ]);
  const id = String(api.conversationId);
  // A rerun after a restart finds the group it started.
  let graphId = startedBy(graphs?.graphs, api.taskId);
  if (graphId === undefined) {
    const allowed = spawner(agents?.agents, id);
    if (typeof allowed === "string") return textResult(allowed, true);
    if (args.agents.length < GRAPH_SIZE.min)
      return textResult("Name at least one agent to spawn.", true);
    const durable = ((await api.snapshot(
      AgentDoc,
      api.conversationId,
      context,
    )) ?? {}) as DurableAgentState;
    const agent = await api.agent(context);
    const own = new Set(options.selection(true).tools.map((tool) => tool.name));
    // Agents get tools their spawner has, besides the tools that make
    // them agents.
    const ownTools = agent.tools.filter((tool) => !own.has(tool.name));
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(
        args,
        options,
        {
          cwd: durable.cwd ?? process.cwd(),
          ...(durable.model ? { model: { ...durable.model } } : {}),
          ...(isThinkingLevel(durable.thinkingLevel)
            ? { thinking: durable.thinkingLevel }
            : {}),
        },
        ownTools,
        agent.callable,
      );
      // Only the call grants spawning, not a profile the model picked,
      // and never beyond the deepest level.
      for (const [index, helper] of planned.helpers.entries()) {
        const asked = args.agents[index]?.spawn === true;
        if (asked && allowed.depth + 1 >= MAX_DEPTH)
          throw new AgentError(
            `${helper.name} can't spawn agents: agents at depth ${MAX_DEPTH} can't, and it would be at depth ${allowed.depth + 1}.`,
          );
        helper.spec = { ...helper.spec, spawn: asked };
      }
    } catch (error) {
      return textResult(errorText(error), true);
    }
    const started = await start(
      api,
      context,
      args,
      { id, ...allowed },
      planned,
      options,
    );
    if ("error" in started) return textResult(started.error, true);
    graphId = started.graph;
  }
  const started = await startedReceipt(api, context, graphId);
  const [now, records] = await Promise.all([
    api.snapshot(GraphsDoc, context),
    api.snapshot(AgentsDoc, context),
  ]);
  const graph = now?.graphs[graphId];
  // Full names and IDs, which address them in agent_wait and agent_stop.
  const members = (graph?.nodes ?? []).map((node) => ({
    id: node.agent,
    name: records?.agents[node.agent]?.name ?? node.agent,
  }));
  const names = members.map((agent) => `${agent.name} (ID ${agent.id})`);
  const structured: Static<typeof SpawnOutput> = {
    group: { id: graphId, name: graph?.name ?? graphId },
    agents: members,
  };
  const what = graph?.single
    ? `Started ${names[0]}.`
    : `Started group ${graph?.name ?? graphId} (ID ${graphId}): ${names.join(", ")}.`;
  return {
    output: [
      {
        type: "text",
        text: `${what} The result arrives as a message once ${graph?.single ? "it answers" : "the group finished"}; call ${WAIT_TOOL} to wait for it instead.`,
      },
    ],
    structuredOutput: structured,
    ...(started
      ? { details: { receipt: receipt({ graphs: [started] }) } }
      : {}),
  };
}

/** What scripts get from `agent_spawn`: the group and its agents, by
 * the full names and IDs that address them in `agent_stop` and
 * `agent_send`. */
export const SpawnOutput = Type.Object(
  {
    group: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
      },
      { additionalProperties: false },
    ),
    agents: Type.Array(
      Type.Object(
        { id: Type.String(), name: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** The agent's own groups whose results still count. */
function ownGroups(
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
  agents: Readonly<Record<string, AgentRecord>> | undefined,
  owner: string,
): Array<[string, GraphRecord]> {
  return Object.entries(graphs ?? {}).filter(
    ([, graph]) =>
      isSpawned(graph) &&
      graph.owner.agent === owner &&
      graph.cancelled !== true &&
      agents?.[owner] !== undefined,
  );
}

/**
 * The group a reference addresses among the agent's own: its ID, its name,
 * or the name of an agent in it, full or without the spawner's prefix. A
 * reference that fits several is an error, never a guess.
 */
function resolveGroup(
  groups: Array<[string, GraphRecord]>,
  agents: Readonly<Record<string, AgentRecord>> | undefined,
  ref: string,
): { id: string; error?: undefined } | { id?: undefined; error: string } {
  const wanted = ref.trim();
  const byId = groups.find(
    ([id, graph]) =>
      id === wanted || graph.nodes.some((node) => node.agent === wanted),
  );
  if (byId) return { id: byId[0] };
  const matches = (exact: boolean) =>
    groups.filter(
      ([, graph]) =>
        (exact && graph.name === wanted) ||
        graph.nodes.some((node) => {
          const name = agents?.[node.agent]?.name;
          return exact ? name === wanted : name?.endsWith(`.${wanted}`);
        }),
    );
  const found = matches(true).length > 0 ? matches(true) : matches(false);
  const [only] = found;
  if (only && found.length === 1) return { id: only[0] };
  if (found.length === 0)
    return { error: `${wanted} is none of your groups or their agents.` };
  return {
    error: `${wanted} fits several of your groups: ${found
      .map(([id, graph]) => `${graph.name} (ID ${id})`)
      .join(", ")}. Name one by its full name or ID.`,
  };
}

type WaitBinding = { groups: string[] };

async function waitExecute(
  args: { names?: string[]; timeout?: number },
  api: Api,
  context: Context,
  options: SpawningOptions,
): Promise<ToolExecutionResult> {
  const id = String(api.conversationId);
  // The first run chooses the groups; every run claims them again, so a
  // rerun after a restart never returns a result that went out as input
  // meanwhile.
  let bound = await api.memo<WaitBinding>("wait", context);
  if (!bound) {
    const [agents, graphs] = await Promise.all([
      api.snapshot(AgentsDoc, context),
      api.snapshot(GraphsDoc, context),
    ]);
    const groups = ownGroups(graphs?.graphs, agents?.agents, id);
    let chosen: string[];
    if (args.names && args.names.length > 0) {
      chosen = [];
      for (const name of args.names) {
        const found = resolveGroup(groups, agents?.agents, name);
        if (found.id === undefined) return textResult(found.error, true);
        if (!chosen.includes(found.id)) chosen.push(found.id);
      }
    } else
      chosen = groups
        .filter(([, graph]) => graph.presented === undefined)
        .map(([group]) => group);
    bound = await api.memo<WaitBinding>("wait", { groups: chosen }, context);
  }
  const chosen = bound.groups;
  // Claim the results in one commit, so they don't arrive as input as
  // well; results already delivered or on their way stay out.
  const claimed = await api.commit(async (tx) => {
    const doc = await tx.doc(GraphsDoc);
    const result: string[] = [];
    for (const group of chosen) {
      const graph = doc.graphs[group];
      if (!graph || graph.cancelled) continue;
      if (graph.presented !== undefined) continue;
      if (graph.attempt !== undefined && graph.withdrawn === undefined)
        continue;
      if (graph.claim !== undefined && graph.claim !== api.taskId) {
        const holder = await tx.task(graph.claim as TaskId);
        if (holder && holder.state.status !== "terminal") continue;
      }
      graph.claim = api.taskId;
      result.push(group);
    }
    return result;
  }, context);
  if (claimed.length === 0)
    return textResult(
      chosen.length === 0
        ? "No results to wait for."
        : "Those results already reached you, or arrive as a message.",
    );
  const groups = claimed;
  const progress = await Promise.all(
    groups.map((group) => startedReceipt(api, context, group)),
  );
  await api.details(
    {
      receipt: receipt({
        graphs: progress.filter((each) => each !== undefined),
      }),
    },
    context,
  );
  const timeout =
    args.timeout !== undefined && args.timeout > 0
      ? AbortSignal.timeout(args.timeout * 1000)
      : undefined;
  const waitContext = timeout ? withAbortSignal(timeout, context) : context;
  const resume = options.pause?.(id);
  try {
    await Promise.all(
      groups.map((group) =>
        api.waitForTask(Number(group) as TaskId, waitContext).catch((error) => {
          if (!timeout?.aborted) throw error;
        }),
      ),
    );
  } finally {
    resume?.();
  }
  const results = await Promise.all(
    groups.map(async (group) => ({
      group,
      ...(await groupResult(api, context, group)),
    })),
  );
  const finished = results.filter((each) => each.finished);
  const pending = results.filter((each) => !each.finished);
  // Unfinished groups deliver as input once they finish. Finished results
  // count only when this direct call commits its model-visible result.
  if (pending.length > 0)
    await api.commit(async (tx) => {
      const doc = await tx.doc(GraphsDoc);
      for (const each of pending) {
        const graph = doc.graphs[each.group];
        if (graph?.claim === api.taskId) delete graph.claim;
      }
    }, context);
  const text = [
    ...finished.map((each) => each.text),
    ...(pending.length > 0
      ? [
          `Timed out; still working: ${pending.map((each) => each.receipt?.name ?? each.group).join(", ")}. Their results arrive as a message.`,
        ]
      : []),
  ].join("\n\n");
  return {
    output: [{ type: "text", text }],
    details: {
      receipt: receipt({
        graphs: results.flatMap((each) => (each.receipt ? [each.receipt] : [])),
        wait: pending.length > 0 ? "timeout" : "done",
      }),
      presented: finished.map((each) => each.group),
    },
  };
}

/** Agents below the agent: those of its groups, and theirs. */
function descendants(
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
  owner: string,
): Set<string> {
  const found = new Set<string>();
  const queue = [owner];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    for (const graph of Object.values(graphs ?? {}))
      if (isSpawned(graph) && graph.owner.agent === next)
        for (const node of graph.nodes)
          if (!found.has(node.agent)) {
            found.add(node.agent);
            queue.push(node.agent);
          }
  }
  return found;
}

type StopBinding = { kind: "agent" | "graph"; id: string; name: string };

/**
 * What a stop addresses among the agent's own groups and the agents below
 * it: an ID, a group's name, or an agent's name, full or without its
 * spawner's prefix. A reference that fits several is an error.
 */
function resolveStop(
  agents: Readonly<Record<string, AgentRecord>> | undefined,
  graphs: Readonly<Record<string, GraphRecord>> | undefined,
  owner: string,
  ref: string,
): StopBinding | string {
  const wanted = ref.trim();
  const groups = ownGroups(graphs, agents, owner).filter(
    ([, graph]) => !graph.single,
  );
  const below = [...descendants(graphs, owner)];
  const candidates: StopBinding[] = [
    ...groups.map(([id, graph]) => ({
      kind: "graph" as const,
      id,
      name: graph.name,
    })),
    ...below.map((id) => ({
      kind: "agent" as const,
      id,
      name: agents?.[id]?.name ?? id,
    })),
  ];
  const byId = candidates.find((each) => each.id === wanted);
  if (byId) return byId;
  const exact = candidates.filter((each) => each.name === wanted);
  const found =
    exact.length > 0
      ? exact
      : candidates.filter((each) => each.name.endsWith(`.${wanted}`));
  const [only] = found;
  if (only && found.length === 1) return only;
  if (found.length === 0)
    return `${wanted} is none of your groups or the agents below you.`;
  return `${wanted} fits several: ${found
    .map((each) => `${each.name} (ID ${each.id})`)
    .join(", ")}. Name one by its full name or ID.`;
}

async function stopExecute(
  args: { name: string },
  api: Api,
  context: Context,
  options: SpawningOptions,
): Promise<ToolExecutionResult> {
  // The first run binds the target by ID, so a rerun never stops another
  // agent that took the name meanwhile.
  let bound = await api.memo<StopBinding>("stop", context);
  if (!bound) {
    const [agents, graphs] = await Promise.all([
      api.snapshot(AgentsDoc, context),
      api.snapshot(GraphsDoc, context),
    ]);
    const found = resolveStop(
      agents?.agents,
      graphs?.graphs,
      String(api.conversationId),
      args.name,
    );
    if (typeof found === "string") return textResult(found, true);
    bound = await api.memo<StopBinding>("stop", found, context);
  }
  // The stop continues if this caller is interrupted, but its refresh may
  // need the caller's turn. Never hold that turn by ignoring cancellation.
  context.abortSignal?.throwIfAborted();
  await awaitWithContext(
    options.hub.stop({ kind: bound.kind, id: bound.id }),
    context,
  );
  return textResult(
    bound.kind === "graph"
      ? `Stopped group ${bound.name}; its result arrives as a message.`
      : `Stopped ${bound.name} and the agents it spawned.`,
  );
}

/** The tools available to agents that may spawn. */
export function spawningTools(options: SpawningOptions): ToolRegistration[] {
  return [
    defineTool({
      name: SPAWN_TOOL,
      description:
        "Spawn one group of agents and return at once. Once all finished, the group's result arrives as one [results] input, or from agent_wait: the final messages of the agents that no other agent lists in after. For one merged answer, add an agent after the others that merges their results; for results that should arrive separately, call agent_spawn once per job.",
      parameters: spawnParameters,
      structuredOutputSchema: SpawnOutput,
      prepareArguments: (args) => checkSpawnShape(args) as never,
      // A rerun finds the group the interrupted call started.
      replay: "safe",
      outputLimits: UNBOUNDED_OUTPUT,
      execute: (args, api, context) =>
        spawnExecute(args as SpawnArgs, api, context, options),
    }),
    defineTool({
      name: WAIT_TOOL,
      // Only a direct result enters model context; a script can discard it.
      callers: ["model"],
      description:
        "Block until groups you spawned finished and return their results, which then don't arrive as a message. Call directly, not from codemode.",
      parameters: waitParameters,
      replay: "safe",
      outputLimits: UNBOUNDED_OUTPUT,
      execute: (args, api, context) => waitExecute(args, api, context, options),
    }),
    defineTool({
      name: STOP_TOOL,
      description:
        "Stop one of your groups, or an agent below you, with the agents it spawned. A stopped group's result still arrives.",
      parameters: stopParameters,
      replay: "safe",
      execute: (args, api, context) => stopExecute(args, api, context, options),
    }),
  ] as ToolRegistration[];
}
