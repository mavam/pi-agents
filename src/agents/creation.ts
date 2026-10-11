/**
 * Agent creation: validates jobs, tools, and names, and creates standalone
 * agents or graphs in their creating commits, before the service refreshes.
 */

import {
  type Conversation,
  configure,
  type Extension,
  type Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { DEFAULT_AGENT_TOOLS } from "../host/tools.js";
import { CONTEXT } from "./context.js";
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
  const available = [...(deps.extensions.tools.tools ?? [])];
  const wanted = names ?? [...DEFAULT_AGENT_TOOLS];
  const unknown = wanted.filter(
    (name) => !available.some((tool) => tool.name === name),
  );
  if (unknown.length > 0)
    throw new AgentError(
      `Unknown tools: ${unknown.join(", ")}. Available: ${available.map((tool) => tool.name).join(", ")}`,
    );
  return wanted.map(
    (name) => available.find((tool) => tool.name === name) as ToolRegistration,
  );
}
