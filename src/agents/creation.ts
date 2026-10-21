/**
 * Agent creation: validates jobs, tools, and names, and creates standalone
 * agents or graphs in their creating commits, before the service refreshes.
 */

import {
  AgentDoc,
  type Conversation,
  configure,
  type Extension,
  type Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import type { AgentExtensionState } from "../hooks.js";
import {
  DEFAULT_AGENT_TOOLS,
  isCodemodeModelTool,
  withCodemodeModels,
} from "../host/tools.js";
import { CONTEXT, conversationId } from "./context.js";
import { DELEGATE_TOOL } from "./delegation.js";
import { type AgentExtensions, agentSelection } from "./extensions.js";
import { GraphTask, NodeTask } from "./graphs.js";
import { claimName, NAME_BASE_LENGTH, takenNames } from "./names.js";
import { AgentsDoc, GraphsDoc, type ParentRequest } from "./records.js";
import { resolveEdges } from "./topology.js";
import {
  AgentError,
  GRAPH_SIZE,
  type GraphPolicy,
  type GraphSpec,
  isThinkingLevel,
  type SpawnSpec,
} from "./types.js";

export interface CreationDeps {
  /** Once per spawn, before its commit; a graph's nodes share the result. */
  captureExtensionState?: () => AgentExtensionState | undefined;
  harness: Harness;
  anchor: Conversation;
  extensions: AgentExtensions;
  takenNames: () => Set<string>;
  workingClosed: () => string[];
}

/** Validate a spawn's job, thinking level, and tools. */
export function prepare(
  deps: CreationDeps,
  spec: SpawnSpec,
): { job: string; tools: ToolRegistration[] } {
  if (spec.thinking !== undefined && !isThinkingLevel(spec.thinking))
    throw new AgentError(`Invalid thinking level: ${spec.thinking}`);
  const tools = resolveTools(deps, spec.tools);
  const job = spec.job.trim();
  if (!job) throw new AgentError("The job must not be empty");
  return { job, tools };
}

/** Create an agent and record its job before the service submits it. */
export async function createAgent(
  deps: CreationDeps,
  spec: SpawnSpec,
  prepared: {
    job: string;
    tools: ToolRegistration[];
    first: string;
    request: ParentRequest;
  },
): Promise<string> {
  const { job, tools, first, request } = prepared;
  const extensionState = deps.captureExtensionState?.();
  const createdAt = Date.now();
  return deps.harness.commit(async (tx) => {
    const state = await tx.doc(AgentsDoc);
    const name = claimName(
      spec.name,
      spec.profile ?? "agent",
      takenNames(state, await tx.doc(GraphsDoc), deps.workingClosed()),
      "agent",
    );
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    await configure(tx, conversation.id, {
      cwd: spec.cwd,
      ...capabilities(deps, tools, spec.delegate),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
      ...(spec.instructions ? { instructions: spec.instructions } : {}),
    });
    state.agents[String(conversation.id)] = {
      name,
      profile: spec.profile ?? null,
      job,
      createdAt,
      closed: false,
      ambientSkills: spec.ambientSkills ?? true,
      ...(extensionState ? { extensionState } : {}),
      nextRequest: 2,
      requests: { [first]: request },
      delivered: [],
      ...(spec.delegate ? { delegate: true } : {}),
    };
    return String(conversation.id);
  }, CONTEXT);
}

/**
 * Start agents that work together and report back as one result. An agent
 * that lists others in `after` starts once they ended and receives their
 * results. One commit creates the graph task, a node task per agent, and
 * each agent's conversation owned by its node; the nodes then send the
 * tasks.
 */
export async function createGraph(
  deps: CreationDeps,
  spec: GraphSpec,
): Promise<{ id: string; agents: string[] }> {
  const count = spec.agents.length;
  if (count < GRAPH_SIZE.min || count > GRAPH_SIZE.max)
    throw new AgentError(
      `A graph has ${GRAPH_SIZE.min} to ${GRAPH_SIZE.max} agents, not ${count}`,
    );
  // Validate with the service's view first; the commit claims for real.
  const claim = (taken: Set<string>) => {
    const graph = claimName(spec.name, "graph", taken, "graph");
    return {
      graph,
      agents: spec.agents.map((agent, index) =>
        claimName(
          agent.name,
          agent.profile ?? `${graph.slice(0, NAME_BASE_LENGTH)}-${index + 1}`,
          taken,
          "agent",
        ),
      ),
    };
  };
  const planned = claim(deps.takenNames());
  const nodes = spec.agents.map((agent, index) => ({
    spec: agent,
    name: planned.agents[index] as string,
    ...prepare(deps, agent),
  }));
  const inputs = resolveEdges(
    nodes.map((node) => ({ name: node.name, after: node.spec.after })),
  );
  // Callbacks finish before any node exists. A failure creates nothing.
  const extensionState = deps.captureExtensionState?.();
  const policy: GraphPolicy = spec.failFast ? "failFast" : "allSettled";
  const createdAt = Date.now();
  return deps.anchor.commit(async (tx) => {
    const names = claim(
      takenNames(
        await tx.doc(AgentsDoc),
        await tx.doc(GraphsDoc),
        deps.workingClosed(),
      ),
    );
    const graph = await tx.createTask(
      GraphTask,
      { policy },
      { ownership: { kind: "conversation" }, background: true },
    );
    const agents: string[] = [];
    const tasks: number[] = [];
    for (const node of nodes) {
      const task = await tx.createTask(
        NodeTask,
        { message: node.job },
        { ownership: { kind: "task", taskId: graph } },
      );
      const conversation = await tx.createConversation({
        ownership: { kind: "task", taskId: task },
      });
      const { spec: agent } = node;
      await configure(tx, conversation.id, {
        cwd: agent.cwd,
        ...capabilities(deps, node.tools, agent.delegate),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.thinking ? { thinkingLevel: agent.thinking } : {}),
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
      });
      agents.push(String(conversation.id));
      tasks.push(task);
    }
    const state = await tx.doc(AgentsDoc);
    nodes.forEach((node, index) => {
      state.agents[agents[index] as string] = {
        name: names.agents[index] as string,
        profile: node.spec.profile ?? null,
        job: node.job,
        createdAt,
        closed: false,
        ambientSkills: node.spec.ambientSkills ?? true,
        ...(extensionState
          ? { extensionState: structuredClone(extensionState) }
          : {}),
        // The node sends the job; parent requests are later messages.
        nextRequest: 1,
        requests: {},
        delivered: [],
        graph: String(graph),
        ...(node.spec.delegate ? { delegate: true } : {}),
      };
    });
    (await tx.doc(GraphsDoc)).graphs[String(graph)] = {
      name: names.graph,
      policy,
      createdAt,
      nodes: nodes.map((_node, index) => ({
        agent: agents[index] as string,
        task: tasks[index] as number,
        after: (inputs[index] ?? []).map((input) => agents[input] as string),
      })),
      closed: false,
      pending: true,
    };
    return { id: String(graph), agents };
  }, CONTEXT);
}

/**
 * The tools and extensions of a new agent, named explicitly, so the
 * harness's default selection never reaches it. A delegating agent also
 * selects the delegation extension and its tool, so only it can start
 * helpers.
 */
function capabilities(
  deps: CreationDeps,
  tools: ToolRegistration[],
  delegate: boolean | undefined,
): { tools: ToolRegistration[]; extensions: Extension[] } {
  const extensions = agentSelection(deps.extensions, {
    delegate: !!delegate,
    messaging: true,
  });
  const extra = [
    ...(delegate
      ? (deps.extensions.delegation.tools ?? []).filter(
          (each) => each.name === DELEGATE_TOOL,
        )
      : []),
    ...(deps.extensions.messaging.tools ?? []),
  ];
  return { tools: [...tools, ...extra], extensions };
}

function resolveTools(
  deps: CreationDeps,
  names: string[] | undefined,
): ToolRegistration[] {
  const all = deps.extensions.tools.tools ?? [];
  // Agents get the internal tools of codemode with it, never by name.
  const available = all.filter((tool) => !isCodemodeModelTool(tool.name));
  const wanted = names ?? [...DEFAULT_AGENT_TOOLS];
  const unknown = wanted.filter(
    (name) => !available.some((tool) => tool.name === name),
  );
  if (unknown.length > 0)
    throw new AgentError(
      `Unknown tools: ${unknown.join(", ")}. Available: ${available.map((tool) => tool.name).join(", ")}`,
    );
  return withCodemodeModels(
    wanted.map(
      (name) =>
        available.find((tool) => tool.name === name) as ToolRegistration,
    ),
    all,
  );
}

/**
 * Enable the internal tools of `codemode` for agents stored before its
 * scripts had `models.*`, so every agent with `codemode` can call
 * `models.classify()` and `models.generateImages()`. Agents without
 * `codemode` stay as they are.
 */
export async function enableCodemodeModels(
  deps: CreationDeps,
  ids: readonly string[],
): Promise<void> {
  const internal = (deps.extensions.tools.tools ?? [])
    .map((tool) => tool.name)
    .filter(isCodemodeModelTool);
  const lacking: string[] = [];
  for (const id of ids) {
    const agent = await deps.harness.snapshot(
      AgentDoc,
      conversationId(id),
      CONTEXT,
    );
    const tools = agent?.tools;
    if (
      Array.isArray(tools) &&
      tools.includes(CODEMODE_TOOL_NAME) &&
      internal.some((name) => !tools.includes(name))
    )
      lacking.push(id);
  }
  if (lacking.length === 0) return;
  await deps.harness.commit(async (tx) => {
    for (const id of lacking) {
      const { tools } = await tx.doc(AgentDoc, conversationId(id));
      if (!Array.isArray(tools)) continue;
      for (const name of internal) if (!tools.includes(name)) tools.push(name);
    }
  }, CONTEXT);
}
