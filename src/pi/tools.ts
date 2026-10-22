/**
 * The parent model's tools: agent_spawn, agent_send, agent_wait,
 * agent_status, and agent_stop.
 */

import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { droppedNote, messageModeParameter } from "../agents/messaging.js";
import {
  observed,
  receipt,
  startedGraph,
  type ToolReceipt,
} from "../agents/receipts.js";
import { turnResult } from "../agents/report.js";
import type { AgentService } from "../agents/service.js";
import {
  AgentError,
  type AgentInfo,
  checkSpawnShape,
  GRAPH_SIZE,
  type GraphInfo,
  messageMode,
  type Stall,
  type Target,
  type TargetRef,
  THINKING_LEVELS,
  WaitInterrupted,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import { graphShape, oneLine } from "../ui/format.js";
import { PARENT_TOOL_VIEWS, positiveSeconds } from "../ui/tool-views.js";
import {
  graphContent,
  graphResultDetails,
  isSingle,
  nodeCounts,
} from "./messages.js";
import {
  AgentOutput,
  agentOutput,
  GraphOutput,
  graphName,
  graphOutput,
  type OutputLookup,
  StatusOutput,
  StopOutput,
  statusOutput,
  stopOutput,
  WaitOutput,
} from "./output.js";
import type { SessionHost } from "./session.js";
import { inheritedTools, resolveSpawn } from "./spawn.js";

const PROGRESS_MS = 1_000;

/** What a call's result stores besides its text: its receipt, for the
 * UI, and what delivery needs to know. */
interface AgentToolDetails {
  receipt: ToolReceipt;
  /** The results the call's wait took instead of their delivery, by ID:
   * stored with the result, they count as delivered. */
  deliveries?: string[];
}

/** The parent's tools, which agents get unless the call or a profile
 * names theirs. */
function inherited(pi: ExtensionAPI): { tools?: string[] } {
  const tools = inheritedTools(pi.getActiveTools());
  return tools ? { tools } : {};
}

function text(content: string, details: AgentToolDetails) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function lookupAgent(service: AgentService) {
  return (id: string) => service.agentById(id);
}

function lookup(service: AgentService): OutputLookup {
  return {
    agent: lookupAgent(service),
    graph: (id) => service.graphById(id),
  };
}

/** An agent as scripts see it now, by ID. */
function agentNow(service: AgentService, id: string): AgentOutput {
  return agentOutput(service.agentById(id) as AgentInfo, (graph) =>
    graphName(service.graphById(graph)),
  );
}

/** A graph as scripts see it now, by ID. */
function graphNow(service: AgentService, id: string): GraphOutput {
  return graphOutput(service.graphById(id) as GraphInfo, (agent) =>
    service.agentById(agent),
  );
}

/** The model-facing summary of one agent: its state and result. */
function describeAgent(info: AgentInfo): string {
  const head = `## ${info.name} (${info.state}${stallText(info)})`;
  const { result, error } = turnResult(info);
  if (error !== undefined) return `${head}\nError: ${error}`;
  if (info.state === "idle") return `${head}\n${result || "(empty)"}`;
  return result ? `${head}\n${result}` : head;
}

/** The model-facing summary of a graph: its result once it finished. A
 * graph of one agent reads as the agent. */
function describeGraph(service: AgentService, graph: GraphInfo): string {
  const details = graphResultDetails(graph, graph.nodes, (id) =>
    service.agentById(id),
  );
  const single = isSingle(details);
  const name = single ? (graph.nodes[0]?.name ?? graph.name) : graph.name;
  const what = single ? name : `Graph ${name}`;
  if (graph.stopped) return `${what} was stopped.`;
  if (graph.state === "working")
    return single
      ? `${what} is still working.`
      : `${what} is still working: ${nodeCounts(details.nodes)}.`;
  return graphContent(details);
}

/** Why a working agent or graph doesn't progress, for the model. */
function stallText(info: { state: string; stalled?: Stall }): string {
  if (info.state !== "working" || !info.stalled) return "";
  return info.stalled === "crashed"
    ? ", stalled after repeated crashes until the user retries it in /agents"
    : ", stalled because this pi-agents version can't run its work";
}

function statusLine(service: AgentService, info: AgentInfo): string {
  const spawning = info.activity.spawning;
  const state =
    info.stalled && info.state === "working"
      ? `${info.state}${stallText(info)}`
      : spawning
        ? `${info.state}, spawned ${spawning.graph} (${spawning.done}/${spawning.total} done)`
        : info.activity.tool
          ? `${info.state}, using ${info.activity.tool}`
          : info.state;
  const graph = info.graph ? service.graphById(info.graph) : undefined;
  const owner = info.owner ? service.agentById(info.owner) : undefined;
  const where =
    graph && !graph.single
      ? `, in graph ${graph.name}`
      : owner
        ? `, spawned by ${owner.name}`
        : "";
  const compaction =
    info.compactionFailure !== undefined
      ? `, its last compaction failed: ${oneLine(info.compactionFailure, 120)}`
      : "";
  return `${info.name} (${state}${where}${compaction}): ${oneLine(info.job, 120)}`;
}

/** Status lines of graphs; a graph of one agent has its agent's line
 * only. */
function graphLines(graphs: readonly GraphInfo[]): string[] {
  return graphs.filter((graph) => !graph.single).map(graphStatusLine);
}

function graphStatusLine(graph: GraphInfo): string {
  const done = graph.nodes.filter((node) => node.outcome).length;
  return `${graph.name} (graph, ${graph.stopped ? "stopped" : graph.state}${stallText(graph)}, ${done}/${graph.nodes.length} done): ${graphShape(graph)}`;
}

/** Agents to show with graphs: theirs, in order, without repeats. */
function withNodes(
  service: AgentService,
  graphs: readonly GraphInfo[],
  agents: readonly AgentInfo[],
): AgentInfo[] {
  const seen = new Set<string>();
  const result: AgentInfo[] = [];
  const add = (info: AgentInfo | undefined) => {
    if (!info || seen.has(info.id)) return;
    seen.add(info.id);
    result.push(info);
  };
  for (const graph of graphs)
    for (const node of graph.nodes) add(service.agentById(node.agentId));
  for (const agent of agents) add(agent);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a call returns: text for the model, details for the UI, and its
 * output for scripts. */
interface Returned<O> {
  content: string;
  details: AgentToolDetails;
  output: O;
}

type Execute<T extends TSchema, O extends TSchema> = (
  service: AgentService,
  params: Static<T>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
) => Promise<Returned<Static<O>>>;

interface AgentToolSpec<T extends TSchema, O extends TSchema> {
  /** A name `PARENT_TOOL_VIEWS` draws. */
  name: string;
  description: string;
  exposure?: ToolDefinition["exposure"];
  parameters: T;
  /** The schema of the output scripts get. */
  output: O;
  /** Checks the arguments, after the common preparation, by throwing. */
  prepare?: (args: unknown) => unknown;
  execute: Execute<T, O>;
}

/** Normalize positive timeout seconds, accepting numeric strings. */
export function prepareArguments(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const prepared = { ...(args as Record<string, unknown>) };
  for (const key of ["timeout"]) {
    if (!(key in prepared)) continue;
    const parsed = positiveSeconds(prepared[key]);
    if (parsed === undefined) delete prepared[key];
    else prepared[key] = parsed;
  }
  return prepared;
}

function defineAgentTool<T extends TSchema, O extends TSchema>(
  host: SessionHost,
  spec: AgentToolSpec<T, O>,
): ToolDefinition<T, AgentToolDetails> {
  const views = PARENT_TOOL_VIEWS[spec.name];
  if (!views) throw new Error(`No view for ${spec.name}`);
  return {
    name: spec.name,
    label: views.label,
    description: spec.description,
    ...(spec.exposure ? { exposure: spec.exposure } : {}),
    parameters: spec.parameters,
    outputSchema: spec.output,
    prepareArguments: (args) =>
      (spec.prepare ?? ((each) => each))(prepareArguments(args)) as Static<T>,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let service: AgentService;
      try {
        service = await host.ensure(ctx);
      } catch (error) {
        throw new Error(`Agents are unavailable: ${errorMessage(error)}`);
      }
      try {
        const result = await spec.execute(
          service,
          params,
          ctx,
          signal,
          onUpdate,
        );
        return {
          ...text(result.content, result.details),
          structuredContent: result.output as JsonValue,
        };
      } catch (error) {
        if (error instanceof AgentError) throw new Error(error.message);
        throw error;
      }
    },
    // Calls draw their arguments, results their receipts: see
    // `src/ui/tool-views.ts`.
    renderCall: views.renderCall,
    renderResult: views.renderResult,
  };
}

/**
 * `agent_wait`: block for agents, streaming their lines as progress for
 * RPC clients; the panel shows the live states. The wait ends
 * early when the parent is needed, such as when the user steers, so Pi can
 * place the steer instead of holding it back.
 */
async function waitWithProgress(
  service: AgentService,
  targets: readonly TargetRef[],
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
): Promise<Returned<WaitOutput>> {
  const snapshot = () => {
    const graphs = targets.flatMap((target) => {
      const info =
        target.kind === "graph" ? service.graphById(target.id) : undefined;
      return info ? [info] : [];
    });
    const agents = targets.flatMap((target) => {
      const info =
        target.kind === "agent" ? service.agentById(target.id) : undefined;
      return info ? [info] : [];
    });
    return { graphs, agents };
  };
  const progress = () => {
    const { graphs, agents } = snapshot();
    onUpdate?.(
      text(
        [
          ...graphLines(graphs),
          ...withNodes(service, graphs, agents).map((info) =>
            statusLine(service, info),
          ),
        ].join("\n"),
        { receipt: receipt() },
      ),
    );
  };
  progress();
  const timer = setInterval(progress, PROGRESS_MS);
  try {
    const outcome = await service.waitFor(targets, {
      ...(signal ? { signal } : {}),
      ...(timeoutSeconds !== undefined
        ? { timeoutMs: timeoutSeconds * 1000 }
        : {}),
      // Only Pi's stored direct result confirms these deliveries.
      carrier: true,
    });
    const content = [
      ...outcome.graphs.map((graph) => describeGraph(service, graph)),
      ...outcome.agents.map(describeAgent),
    ].join("\n\n");
    return {
      output: {
        ...statusOutput(outcome.agents, outcome.graphs, lookup(service)),
        pending: outcome.timedOut,
      },
      content:
        outcome.timedOut.length > 0
          ? `${content}\n\nTimed out; still working: ${outcome.timedOut.join(", ")}.`
          : content,
      details: {
        receipt: observed(
          outcome.graphs,
          outcome.agents,
          lookupAgent(service),
          outcome.timedOut.length > 0 ? "timeout" : "done",
        ),
        ...(outcome.deliveries.length > 0
          ? { deliveries: outcome.deliveries }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof WaitInterrupted) {
      const steered = error.reason === "attention";
      const { graphs, agents } = snapshot();
      return {
        output: {
          ...statusOutput(agents, graphs, lookup(service)),
          pending: [
            ...agents.filter(
              (info) => info.state === "working" || info.state === "waiting",
            ),
            ...graphs.filter((graph) => graph.state === "working"),
          ].map((info) => info.name),
        },
        content: steered
          ? "Stopped waiting because the user sent a message. The agents keep working; their results arrive as messages."
          : "Stopped waiting. The agents keep working.",
        details: {
          receipt: observed(
            graphs,
            agents,
            lookupAgent(service),
            steered ? "attention" : "cancelled",
          ),
        },
      };
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

/** What one agent gets: its job and settings. */
const agentFields = {
  job: Type.String({
    description:
      "Self-contained instructions; the agent can't see this conversation",
  }),
  name: Type.Optional(
    Type.String({ description: "Short name, such as a role" }),
  ),
  profile: Type.Optional(Type.String({ description: "Profile name" })),
  model: Type.Optional(
    Type.String({ description: "Model, such as sonnet or opus" }),
  ),
  thinking: Type.Optional(
    StringEnum(THINKING_LEVELS, { description: "Thinking level" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: `Tool allowlist from: ${AGENT_TOOL_NAMES.join(", ")}. Defaults to your own tools among them`,
    }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Skills to load in full instead of the skill catalog; [] for none",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  spawn: Type.Optional(
    Type.Boolean({
      description:
        "Let this agent spawn agents of its own, which report back to it. Default false",
    }),
  ),
};

function describeTarget(service: AgentService, target: Target): string {
  return target.kind === "graph"
    ? graphStatusLine(target.info)
    : statusLine(service, target.info);
}

export function registerAgentTools(pi: ExtensionAPI, host: SessionHost): void {
  const spawnParams = Type.Object({
    name: Type.Optional(
      Type.String({
        description:
          "Short name for the whole group, when it has several agents; each agent's own name goes in its entry",
      }),
    ),
    agents: Type.Array(
      Type.Object({
        ...agentFields,
        after: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Names of agents in this call whose final messages this agent needs; it starts once they finished. Agents without after start at once",
          }),
        ),
      }),
      {
        minItems: GRAPH_SIZE.min,
        maxItems: GRAPH_SIZE.max,
        description:
          'Always an array, one entry per agent with its fields, also for a single agent: {"agents": [{"name": "lead", "job": "...", "spawn": true}]}',
      },
    ),
    failFast: Type.Optional(
      Type.Boolean({
        description: "Stop the other agents as soon as one fails",
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      description:
        "Start one group of agents and return at once. Once all finished, the group's result arrives as one message that starts a new turn: the final messages of the agents that no other agent lists in after. For one merged answer, add an agent after the others that merges their results; for results that should arrive separately, call agent_spawn once per job.",
      parameters: spawnParams,
      prepare: checkSpawnShape,
      output: GraphOutput,
      async execute(service, params, ctx) {
        const thinking = pi.getThinkingLevel();
        const tools = inherited(pi);
        const graph = await service.spawnGraph({
          ...(params.name ? { name: params.name } : {}),
          ...(params.failFast ? { failFast: true } : {}),
          // Every agent resolves before any starts.
          agents: await Promise.all(
            params.agents.map(async (agent) => ({
              ...(await resolveSpawn(agent, ctx, {
                skills: host.skills.get,
                thinking,
                ...tools,
              })),
              ...(agent.after ? { after: agent.after } : {}),
            })),
          ),
        });
        const started = receipt({
          graphs: [startedGraph(graph, lookupAgent(service))],
        });
        return {
          content: graph.single
            ? `Started ${graph.name}.`
            : `Started graph ${graph.name}: ${graphShape(graph)}.`,
          details: { receipt: started },
          output: graphNow(service, graph.id),
        };
      },
    }),
  );

  const sendParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
    message: Type.String({
      description: "What to tell the agent; it receives it as your input",
    }),
    mode: messageModeParameter("agent"),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_send",
      description:
        "Send a message to an agent, also one that answered or was stopped, and return at once. Its answer arrives on its own as a message.",
      parameters: sendParams,
      output: AgentOutput,
      async execute(service, params) {
        const before = service.get(params.name);
        // Calls from before `mode` existed set `followUp`.
        const mode = messageMode(params);
        const sent = await service.send(params.name, params.message, mode);
        const info = service.agentById(sent.agent.id) as AgentInfo;
        const working = before?.state === "working";
        const sentText = !working
          ? `Sent to ${info.name}.`
          : mode === "interrupt"
            ? `Interrupted ${info.name} and sent the message.`
            : mode === "followUp"
              ? `Queued for ${info.name}.`
              : `Steered ${info.name}.`;
        return {
          content: `${sentText}${droppedNote(sent.dropped)}`,
          details: { receipt: receipt() },
          output: agentNow(service, info.id),
        };
      },
    }),
  );

  const waitParams = Type.Object({
    names: Type.Array(Type.String(), {
      minItems: 1,
      description: "Agent or graph names",
    }),
    timeout: Type.Optional(
      Type.Number({
        description: "Give up after this many seconds",
        minimum: 1,
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_wait",
      exposure: "model-only",
      description:
        "Block the current turn until agents or graphs answer, or a message from the user interrupts, and return their results, which then don't arrive as messages. Call directly, not from codemode.",
      parameters: waitParams,
      output: WaitOutput,
      execute: (service, params, _ctx, signal, onUpdate) =>
        waitWithProgress(
          service,
          params.names.map((name) => {
            const target = service.find(name);
            if (!target) throw new AgentError(`No agent named ${name}`);
            return { kind: target.kind, id: target.info.id };
          }),
          params.timeout,
          signal,
          onUpdate,
        ),
    }),
  );

  const statusParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Agent or graph name; omit for all" }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_status",
      description: "List agents and graphs with their state and job.",
      parameters: statusParams,
      output: StatusOutput,
      async execute(service, params) {
        if (params.name) {
          const target = service.find(params.name);
          if (!target) throw new AgentError(`No agent named ${params.name}`);
          const graphs = target.kind === "graph" ? [target.info] : [];
          const agents = target.kind === "agent" ? [target.info] : [];
          return {
            content: describeTarget(service, target),
            details: {
              receipt: observed(graphs, agents, lookupAgent(service)),
            },
            output: statusOutput(agents, graphs, lookup(service)),
          };
        }
        const graphs = service.graphs();
        const agents = service.list();
        const lines = [
          ...graphLines(graphs),
          ...agents.map((info) => statusLine(service, info)),
        ];
        return {
          content: lines.length === 0 ? "No agents." : lines.join("\n"),
          details: { receipt: observed(graphs, agents, lookupAgent(service)) },
          output: statusOutput(agents, graphs, lookup(service)),
        };
      },
    }),
  );

  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_stop",
      description:
        "Stop an agent or a graph: end its work and remove it. Messaging an agent later starts it again.",
      parameters: Type.Object({
        name: Type.String({ description: "Agent or graph name" }),
      }),
      output: StopOutput,
      async execute(service, params) {
        const target = await service.stop(params.name);
        const output = stopOutput(target);
        if (target.kind === "graph")
          return {
            content: `Stopped graph ${target.info.name} and its agents.`,
            details: {
              receipt: observed([target.info], [], lookupAgent(service)),
            },
            output,
          };
        return {
          content: `Stopped ${target.info.name}.`,
          details: {
            receipt: observed([], [target.info], lookupAgent(service)),
          },
          output,
        };
      },
    }),
  );
}
