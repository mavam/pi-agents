/**
 * Delegation: an agent with `delegate` gets the tool `delegate_graph`, which
 * starts a graph of helper agents, waits for it, and returns its result. The
 * tool call owns the graph task, so the graph is part of the agent's run:
 *
 *   delegating agent's conversation
 *   └─ pi.generation → pi.tool (delegate_graph)
 *      └─ graph task
 *         └─ node task × n
 *            └─ helper conversation
 *
 * Interrupting the agent interrupts its helpers, stopping a graph above it
 * reaches them, and a restart reruns the call, which finds the graph it
 * already started and waits again.
 *
 * Helpers are depth 2 by construction: a conversation owned by a task
 * copies the agent settings of that task's conversation, so every helper is
 * configured explicitly, with the extensions of agents but not delegation,
 * and the tool refuses agents whose record doesn't allow it.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  type AgentState as DurableAgentState,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type TaskId,
  type TaskOutcome,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { GraphTask, type NodeResult, NodeTask } from "./graphs.js";
import { claimName, NAME_BASE_LENGTH, takenNames } from "./names.js";
import {
  type AgentRecord,
  AgentsDoc,
  type GraphRecord,
  GraphsDoc,
} from "./records.js";
import {
  graphReport,
  type NodeKind,
  type ReportNode,
  type ResultLimit,
} from "./report.js";
import { endNodes, resolveEdges } from "./topology.js";
import {
  AgentError,
  type GraphPolicy,
  type HelperDefaults,
  type HelperResolver,
  isThinkingLevel,
  type SpawnSpec,
  THINKING_LEVELS,
} from "./types.js";

export const DELEGATION_EXTENSION = "pi-agents-delegation";
export const DELEGATE_TOOL = "delegate_graph";

/** How far delegation reaches. Fixed: no configuration. */
export interface DelegationLimits {
  /** Helpers one call starts. */
  perCall: number;
  /** Helpers one agent starts over its lifetime. */
  perAgent: number;
  /** Helpers working at once across the session. */
  active: number;
}

export const DELEGATION_LIMITS: DelegationLimits = {
  perCall: 12,
  perAgent: 24,
  active: 16,
};

/** The text budget of a tool result, below pi-durable's output limit. */
const RESULT_CHARS = 30_000;
const RESULT_LINES = 1_500;

const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const parameters = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Short name for this set of helpers" }),
  ),
  agents: Type.Array(
    Type.Object({
      task: Type.String({
        description:
          "Self-contained task; the helper does not see your conversation",
      }),
      name: Type.Optional(
        Type.String({ description: "Short name, such as a role" }),
      ),
      after: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Names of helpers in this call whose final messages this helper needs; it starts once they finished",
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
    }),
    { minItems: 1, description: "One entry per helper" },
  ),
  failFast: Type.Optional(
    Type.Boolean({ description: "Stop the other helpers when one fails" }),
  ),
});

type Args = Static<typeof parameters>;
type Api = ToolExecutionApi;

export interface DelegationOptions {
  resolve: HelperResolver;
  limits: DelegationLimits;
  /** What helpers select: the extensions of agents, without delegation. */
  extensions: readonly Extension[];
}

function textResult(text: string, isError = false): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  if (message?.role !== "assistant") return "";
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

/** Read inside a commit that changes nothing. */
async function read<T>(
  api: Api,
  context: Context,
  reader: (tx: Parameters<Parameters<Api["commit"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return api.commit(reader, context);
}

/** The graph this call already started, if a rerun finds one. */
function startedBy(
  graphs: Record<string, GraphRecord> | undefined,
  tool: number,
): string | undefined {
  return Object.entries(graphs ?? {}).find(
    ([, graph]) => graph.owner?.tool === tool,
  )?.[0];
}

interface Planned {
  name: string;
  spec: SpawnSpec;
  tools: ToolRegistration[];
}

/** Resolve and check every helper before anything starts. */
async function plan(
  args: Args,
  options: DelegationOptions,
  defaults: HelperDefaults,
  own: readonly ToolRegistration[],
): Promise<{ helpers: Planned[]; inputs: number[][] }> {
  if (args.agents.length > options.limits.perCall)
    throw new AgentError(
      `One call starts at most ${options.limits.perCall} helpers, not ${args.agents.length}`,
    );
  const names = args.agents.map((agent, index) => {
    const name = agent.name?.trim() || `${index + 1}`;
    if (!HELPER_NAME.test(name))
      throw new AgentError(
        `Invalid helper name "${name}": use letters, digits, '_', or '-' (at most 32 characters)`,
      );
    return name;
  });
  if (new Set(names).size !== names.length)
    throw new AgentError("Helper names must differ within one call");
  const inputs = resolveEdges(
    names.map((name, index) => ({
      name,
      ...(args.agents[index]?.after
        ? { after: args.agents[index]?.after }
        : {}),
    })),
  );
  const helpers: Planned[] = [];
  for (const [index, agent] of args.agents.entries()) {
    const name = names[index] as string;
    if (!agent.task.trim())
      throw new AgentError(`The task of helper ${name} must not be empty`);
    const spec = await options.resolve(
      {
        task: agent.task,
        ...(agent.profile ? { profile: agent.profile } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.thinking ? { thinking: agent.thinking } : {}),
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(agent.skills ? { skills: agent.skills } : {}),
      },
      defaults,
    );
    if (spec.thinking !== undefined && !isThinkingLevel(spec.thinking))
      throw new AgentError(`Invalid thinking level: ${spec.thinking}`);
    // Helpers never get tools their agent lacks.
    const wanted = spec.tools ?? own.map((tool) => tool.name);
    const missing = wanted.filter(
      (tool) => !own.some((each) => each.name === tool),
    );
    if (missing.length > 0)
      throw new AgentError(
        `Helper ${name} asks for tools you don't have: ${missing.join(", ")}. Your tools: ${own.map((tool) => tool.name).join(", ") || "none"}`,
      );
    const tools = wanted.map(
      (tool) => own.find((each) => each.name === tool) as ToolRegistration,
    );
    helpers.push({ name, spec, tools });
  }
  return { helpers, inputs };
}

/** `<agent>.<part>`, shortening the agent's name to fit a generated name. */
function qualify(agent: string, part: string): string {
  return `${agent.slice(0, Math.max(1, NAME_BASE_LENGTH - 1 - part.length))}.${part}`;
}

/** Helpers working right now: their nodes aren't terminal. */
async function activeHelpers(
  tx: Parameters<Parameters<Api["commit"]>[0]>[0],
  graphs: Record<string, GraphRecord>,
): Promise<number> {
  let count = 0;
  for (const graph of Object.values(graphs)) {
    if (!graph.owner || graph.closed) continue;
    for (const node of graph.nodes) {
      const task = await tx.task(node.task as TaskId);
      if (task && task.state.status !== "terminal") count += 1;
    }
  }
  return count;
}

/** Start the helpers in one commit; an error string when a limit says no. */
async function start(
  api: Api,
  context: Context,
  args: Args,
  delegator: { id: string; record: AgentRecord },
  planned: { helpers: Planned[]; inputs: number[][] },
  options: DelegationOptions,
): Promise<{ graph: string } | { error: string }> {
  const { limits } = options;
  return api.commit(async (tx) => {
    const graphsDoc = await tx.doc(GraphsDoc);
    const existing = startedBy(graphsDoc.graphs, api.taskId);
    if (existing) return { graph: existing };
    const started = Object.values(graphsDoc.graphs)
      .filter((graph) => graph.owner?.agent === delegator.id)
      .reduce((sum, graph) => sum + graph.nodes.length, 0);
    const count = planned.helpers.length;
    if (started + count > limits.perAgent)
      return {
        error: `You can start ${limits.perAgent} helpers in total and started ${started}, so ${count} more is too many.`,
      };
    const active = await activeHelpers(tx, graphsDoc.graphs);
    if (active + count > limits.active)
      return {
        error: `At most ${limits.active} helpers can work at once in this session and ${active} do. Start fewer, or try again once some finished.`,
      };
    const agentsDoc = await tx.doc(AgentsDoc);
    const taken = takenNames(agentsDoc, graphsDoc);
    const requested = args.name?.trim();
    const graphName = claimName(
      undefined,
      qualify(
        delegator.record.name,
        requested && HELPER_NAME.test(requested) ? requested : "helpers",
      ),
      taken,
      "graph",
    );
    const names = planned.helpers.map((helper) =>
      claimName(
        undefined,
        qualify(delegator.record.name, helper.name),
        taken,
        "agent",
      ),
    );
    const policy: GraphPolicy = args.failFast ? "failFast" : "allSettled";
    const graph = await tx.createTask(
      GraphTask,
      { policy },
      { ownership: { kind: "task", taskId: api.taskId } },
    );
    const agents: string[] = [];
    const tasks: number[] = [];
    for (const helper of planned.helpers) {
      const task = await tx.createTask(
        NodeTask,
        { message: helper.spec.task.trim() },
        { ownership: { kind: "task", taskId: graph } },
      );
      const conversation = await tx.createConversation({
        ownership: { kind: "task", taskId: task },
      });
      const { spec } = helper;
      // Everything explicit: the copy of the delegating agent's settings
      // must not reach the helper, least of all the delegation tool.
      await configure(tx, conversation.id, {
        extensions: options.extensions,
        tools: helper.tools,
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
        task: helper.spec.task.trim(),
        createdAt,
        closed: false,
        ambientSkills: helper.spec.ambientSkills ?? true,
        nextRequest: 1,
        requests: {},
        delivered: [],
        graph: String(graph),
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
      // The tool result is the delivery; Pi's outbox isn't involved.
      pending: false,
      owner: { agent: delegator.id, tool: api.taskId },
    };
    return { graph: String(graph) };
  }, context);
}

/** One helper's outcome for the report, from stored records only. */
async function reportNode(
  api: Api,
  context: Context,
  name: string,
  end: boolean,
  node: number,
): Promise<ReportNode> {
  const record = await api.getTask(node as TaskId, context);
  const state = record?.state;
  const outcome =
    state?.status === "terminal" || state?.status === "completing"
      ? (state.outcome as TaskOutcome<JsonValue>)
      : undefined;
  const of = (kind: NodeKind, body = ""): ReportNode => ({
    name,
    kind,
    body,
    end,
  });
  if (!outcome) return of("working");
  switch (outcome.status) {
    case "completed": {
      const result = outcome.result as NodeResult;
      if (result.kind === "skipped") return of("skipped");
      if (result.kind === "interrupted") return of("interrupted");
      const entry = await read(api, context, (tx) =>
        tx.entry(result.entryId as EntryRecord["id"]),
      );
      return of("answered", assistantText(entry));
    }
    case "aborted":
      return of("stopped");
    case "orphaned":
      return of("failed", outcome.reason);
    default:
      return of("failed", outcome.error.message);
  }
}

/** The graph's result as the tool's text, within the output budget. */
async function report(
  api: Api,
  context: Context,
  graphId: string,
): Promise<string> {
  const [graphs, agents] = await Promise.all([
    api.snapshot(GraphsDoc, context),
    api.snapshot(AgentsDoc, context),
  ]);
  const graph = graphs?.graphs[graphId];
  if (!graph) return "The helpers are missing.";
  const ends = new Set(
    endNodes(
      graph.nodes.map((node) => ({ key: node.agent, inputs: node.after })),
    ),
  );
  const nodes = await Promise.all(
    graph.nodes.map((node) =>
      reportNode(
        api,
        context,
        agents?.agents[node.agent]?.name ?? node.agent,
        ends.has(node.agent),
        node.task,
      ),
    ),
  );
  const settled = await api.getTask(Number(graphId) as TaskId, context);
  const stopped =
    graph.stopped === true ||
    (settled?.state.status === "terminal" &&
      settled.state.outcome.status === "aborted");
  const answered = Math.max(
    1,
    nodes.filter((node) => node.end && node.kind === "answered").length,
  );
  const limit: ResultLimit = {
    chars: Math.floor(RESULT_CHARS / answered),
    lines: Math.floor(RESULT_LINES / answered),
    hint: "Ask for shorter results if you need all of them.",
  };
  const text = graphReport(graph.name, nodes, limit);
  return stopped
    ? `The helpers were stopped before they finished.\n\n${text}`
    : text;
}

async function execute(
  args: Args,
  api: Api,
  context: Context,
  options: DelegationOptions,
): Promise<ToolExecutionResult> {
  const [agents, graphs] = await Promise.all([
    api.snapshot(AgentsDoc, context),
    api.snapshot(GraphsDoc, context),
  ]);
  const id = String(api.conversationId);
  const record = agents?.agents[id];
  const own = record?.graph ? graphs?.graphs[record.graph] : undefined;
  if (!record?.delegate || own?.owner)
    return textResult(`${DELEGATE_TOOL} is not available to you.`, true);
  // A rerun after a restart finds the graph it started and waits again.
  let graphId = startedBy(graphs?.graphs, api.taskId);
  if (graphId === undefined) {
    const durable = ((await api.snapshot(
      AgentDoc,
      api.conversationId,
      context,
    )) ?? {}) as DurableAgentState;
    const agent = await api.agent(context);
    const ownTools = agent.tools.filter((tool) => tool.name !== DELEGATE_TOOL);
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
      );
    } catch (error) {
      return textResult(errorText(error), true);
    }
    const started = await start(
      api,
      context,
      args,
      { id, record },
      planned,
      options,
    );
    if ("error" in started) return textResult(started.error, true);
    graphId = started.graph;
  }
  await api.waitForTask(Number(graphId) as TaskId, context);
  return textResult(await report(api, context, graphId));
}

export function createDelegationExtension(
  options: DelegationOptions,
): Extension {
  return defineExtension({
    name: DELEGATION_EXTENSION,
    tools: [
      defineTool({
        name: DELEGATE_TOOL,
        description:
          "Split your task among helper agents and wait for their results. Helpers run in parallel; one that lists others in after starts once they finished and receives their final messages. Returns the final messages of the helpers nothing waits for, so add a helper after the others to merge their results into one. Helpers don't see your conversation.",
        parameters,
        // A rerun finds the graph the interrupted call started.
        replay: "safe",
        execute: (args, api, context) => execute(args, api, context, options),
      }),
    ],
  });
}
