/** Planning and receipts shared by the durable spawning tools. */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type AgentState as DurableAgentState,
  type EntryRecord,
  type TaskId,
  type TaskOutcome,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { withCodemodeModels } from "../host/tools.js";
import { summarizeUsage, sumUsage } from "./derive.js";
import type { NodeResult } from "./graphs.js";
import { NAME_BASE_LENGTH } from "./names.js";
import {
  type AgentReceipt,
  endsOutcome,
  type GraphReceipt,
  isFinished,
  receipt,
} from "./receipts.js";
import {
  type AgentRecord,
  AgentsDoc,
  type GraphRecord,
  GraphsDoc,
} from "./records.js";
import type { NodeKind, ReportNode } from "./report.js";
import { resolveEdges } from "./topology.js";
import {
  AgentError,
  type HelperDefaults,
  type HelperResolver,
  isThinkingLevel,
  type SpawnSpec,
} from "./types.js";

type Api = ToolExecutionApi;

/** How far spawning reaches. Fixed: no configuration. */
export interface SpawningLimits {
  /** Helpers one call starts. */
  perCall: number;
  /** Helpers one agent starts over its lifetime. */
  perAgent: number;
  /** Helpers working at once across the session. */
  active: number;
}

export const SPAWNING_LIMITS: SpawningLimits = {
  perCall: 12,
  perAgent: 24,
  active: 16,
};

export const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** What planning reads of a call's arguments. */
export interface PlanArgs {
  agents: ReadonlyArray<{
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
}
export function textResult(
  text: string,
  isError = false,
  graph?: GraphReceipt,
): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
    ...(graph
      ? { details: { receipt: receipt({ graphs: [graph], wait: "done" }) } }
      : {}),
  };
}

export function errorText(error: unknown): string {
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

export interface Planned {
  name: string;
  spec: SpawnSpec;
  tools: ToolRegistration[];
}

/** Resolve and check every helper before anything starts. */
export async function plan(
  args: PlanArgs,
  options: { resolve: HelperResolver; limits: SpawningLimits },
  defaults: HelperDefaults,
  own: readonly ToolRegistration[],
  callable: readonly ToolRegistration[],
): Promise<{ helpers: Planned[]; inputs: number[][] }> {
  if (args.agents.length > options.limits.perCall)
    throw new AgentError(
      `One call starts at most ${options.limits.perCall} agents, not ${args.agents.length}`,
    );
  const names = args.agents.map((agent, index) => {
    const name = agent.name?.trim() || `${index + 1}`;
    if (!HELPER_NAME.test(name))
      throw new AgentError(
        `Invalid agent name "${name}": use letters, digits, '_', or '-' (at most 32 characters)`,
      );
    return name;
  });
  if (new Set(names).size !== names.length)
    throw new AgentError("Agent names must differ within one call");
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
    if (!agent.job.trim())
      throw new AgentError(`The job of agent ${name} must not be empty`);
    const spec = await options.resolve(
      {
        job: agent.job,
        ...(agent.profile ? { profile: agent.profile } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.thinking ? { thinking: agent.thinking } : {}),
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(agent.skills ? { skills: agent.skills } : {}),
        ...(agent.spawn !== undefined ? { spawn: agent.spawn } : {}),
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
        `Agent ${name} asks for tools you don't have: ${missing.join(", ")}. Your tools: ${own.map((tool) => tool.name).join(", ") || "none"}`,
      );
    // With codemode, helpers get the internal tools of its models.* that
    // their agent's scripts can call.
    const tools = withCodemodeModels(
      wanted.map(
        (tool) => own.find((each) => each.name === tool) as ToolRegistration,
      ),
      callable,
    );
    helpers.push({ name, spec, tools });
  }
  return { helpers, inputs };
}

/** `<agent>.<part>`, shortening the agent's name to fit a generated name. */
export function qualify(agent: string, part: string): string {
  return `${agent.slice(0, Math.max(1, NAME_BASE_LENGTH - 1 - part.length))}.${part}`;
}

/** Helpers working right now: their nodes aren't terminal. */
export async function activeHelpers(
  tx: Parameters<Parameters<Api["commit"]>[0]>[0],
  graphs: Record<string, GraphRecord>,
): Promise<number> {
  let count = 0;
  // Closed graphs count too: a graph closes when its result is
  // delivered, which can be before its agents' jobs ended.
  for (const graph of Object.values(graphs)) {
    if (!graph.owner || graph.cancelled) continue;
    for (const node of graph.nodes) {
      const task = await tx.task(node.task as TaskId);
      if (task && task.state.status !== "terminal") count += 1;
    }
  }
  return count;
}

/** One helper's outcome for the report, from stored records only. */
export async function reportNode(
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

/** A helper's name below the agent that started it: `lead.api` reads as
 * `api`, also when `lead` was cut to fit. */
function helperName(name: string, owner: string | undefined): string {
  const dot = name.indexOf(".");
  return owner !== undefined && dot > 0 && owner.startsWith(name.slice(0, dot))
    ? name.slice(dot + 1)
    : name;
}

/**
 * The helpers as the agent's receipt shows them: who they are and who waits
 * for whom, and with `nodes`, how each did its job, from stored records.
 */
export async function helpersReceipt(
  api: Api,
  context: Context,
  graph: GraphRecord,
  names: (agent: string) => string,
  nodes?: readonly ReportNode[],
  stopped = false,
): Promise<GraphReceipt> {
  const agents: AgentReceipt[] = await Promise.all(
    graph.nodes.map(async (node, index) => {
      const cid = Number(node.agent) as Parameters<Api["conversation"]>[0];
      const [durable, usage] = await Promise.all([
        api.snapshot(AgentDoc, cid, context) as Promise<
          DurableAgentState | undefined
        >,
        nodes ? api.snapshot(UsageDoc, cid, context) : undefined,
      ]);
      const result = nodes?.[index];
      const inputs = node.after.map(names);
      return {
        name: names(node.agent),
        ...(durable?.model?.modelId ? { model: durable.model.modelId } : {}),
        ...(inputs.length > 0 ? { inputs } : {}),
        ...(result
          ? {
              outcome: result.kind,
              ...(isFinished(result.kind)
                ? { usage: summarizeUsage(usage) }
                : {}),
              ...(result.body ? { body: result.body } : {}),
            }
          : {}),
      };
    }),
  );
  const owner = graph.owner ? names(graph.owner.agent) : undefined;
  if (!nodes) return { name: helperName(graph.name, owner), agents };
  const ends = nodes.filter((node) => node.end).map((node) => node.kind);
  return {
    name: helperName(graph.name, owner),
    outcome: stopped ? "stopped" : endsOutcome(ends),
    usage: sumUsage(agents.flatMap((agent) => agent.usage ?? [])),
    agents,
  };
}

/** Names of a graph's agents by conversation ID: helpers' without their
 * agent's, which itself keeps its own. */
export function helperNames(
  graph: GraphRecord,
  agents: Readonly<Record<string, AgentRecord>> | undefined,
): (agent: string) => string {
  const owner = graph.owner ? agents?.[graph.owner.agent]?.name : undefined;
  return (agent) => {
    const name = agents?.[agent]?.name ?? agent;
    return agent === graph.owner?.agent ? name : helperName(name, owner);
  };
}

/** What the call started, for its progress. */
export async function startedReceipt(
  api: Api,
  context: Context,
  graphId: string,
): Promise<GraphReceipt | undefined> {
  const [graphs, agents] = await Promise.all([
    api.snapshot(GraphsDoc, context),
    api.snapshot(AgentsDoc, context),
  ]);
  const graph = graphs?.graphs[graphId];
  if (!graph) return undefined;
  return helpersReceipt(
    api,
    context,
    graph,
    helperNames(graph, agents?.agents),
  );
}
