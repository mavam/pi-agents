/** Create the parent's graphs atomically, after validating jobs, tools, and names. */

import {
  type Conversation,
  configure,
  type Extension,
  type Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { AgentExtensionState } from "../hooks.js";
import {
  DEFAULT_AGENT_TOOLS,
  isCodemodeModelTool,
  withCodemodeModels,
} from "../host/tools.js";
import { CONTEXT } from "./context.js";
import { type AgentExtensions, agentSelection } from "./extensions.js";
import { GraphTask, NodeTask } from "./graphs.js";
import { claimName, NAME_BASE_LENGTH, takenNames } from "./names.js";
import { AgentsDoc, GraphsDoc } from "./records.js";

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
function prepare(
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

/**
 * Start agents that work together and report back as one result. An agent
 * that lists others in `after` starts once they ended and receives their
 * results. One commit creates the graph task, a node task per agent, and
 * each agent's conversation owned by its node; the nodes then send the
 * tasks. A graph of one agent is `single`: it takes no name of its own and
 * shows as its agent.
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
  const single = count === 1;
  const claim = (taken: Set<string>) => {
    if (single) {
      const [only] = spec.agents;
      const agent = claimName(
        only?.name ?? spec.name,
        only?.profile ?? "agent",
        taken,
        "agent",
      );
      return { graph: agent, agents: [agent] };
    }
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
        ...capabilities(deps, node.tools, agent.spawn),
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
        depth: 1,
        ...(node.spec.spawn ? { spawn: true } : {}),
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
      ...(single ? { single: true as const } : {}),
    };
    return { id: String(graph), agents };
  }, CONTEXT);
}

/**
 * The tools and extensions of a new agent, named explicitly, so the
 * harness's default selection never reaches it. An agent that may spawn
 * also selects the spawning tools, so only it can spawn agents.
 */
function capabilities(
  deps: CreationDeps,
  tools: ToolRegistration[],
  spawn: boolean | undefined,
): { tools: ToolRegistration[]; extensions: Extension[] } {
  const extensions = agentSelection(deps.extensions, {
    spawn: !!spawn,
    messaging: true,
  });
  const extra = [
    ...(spawn ? (deps.extensions.spawning.tools ?? []) : []),
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
