/**
 * The parent model's tools: agent_spawn, agent_spawn_graph, agent_send,
 * agent_wait, agent_status, and agent_stop.
 */

import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
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
  GRAPH_SIZE,
  type GraphInfo,
  type Target,
  type TargetRef,
  THINKING_LEVELS,
  WaitInterrupted,
} from "../agents/types.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";
import { graphShape, oneLine } from "../ui/format.js";
import { PARENT_TOOL_VIEWS, positiveSeconds } from "../ui/tool-views.js";
import { callKey } from "./calls.js";
import {
  graphContent,
  graphResultDetails,
  nodeCounts,
  truncateResult,
} from "./messages.js";
import {
  AgentOutput,
  agentOutput,
  GraphOutput,
  graphOutput,
  type OutputLookup,
  StatusOutput,
  StopOutput,
  statusOutput,
  stopOutput,
  WaitOutput,
} from "./output.js";
import type { SessionHost } from "./session.js";
import { resolveSpawn } from "./spawn.js";

const PROGRESS_MS = 1_000;

/** What a call's result stores besides its text: its receipt, for the
 * UI, and what delivery needs to know. */
interface AgentToolDetails {
  receipt: ToolReceipt;
  /** The results the call's wait took instead of their delivery, by ID:
   * stored with the result, they count as delivered. */
  deliveries?: string[];
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
  return agentOutput(
    service.agentById(id) as AgentInfo,
    (graph) => service.graphById(graph)?.name,
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
  const head = `## ${info.name} (${info.state})`;
  const { result, error } = turnResult(info);
  if (error !== undefined) return `${head}\nError: ${error}`;
  if (info.state === "idle")
    return `${head}\n${truncateResult(result || "(empty)")}`;
  return result ? `${head}\n${truncateResult(result)}` : head;
}

/** The model-facing summary of a graph: its result once it finished. */
function describeGraph(service: AgentService, graph: GraphInfo): string {
  const details = graphResultDetails(graph, graph.nodes, (id) =>
    service.agentById(id),
  );
  if (graph.stopped) return `Graph ${graph.name} was stopped.`;
  if (graph.state === "working")
    return `Graph ${graph.name} is still working: ${nodeCounts(details.nodes)}.`;
  return graphContent(details);
}

function statusLine(service: AgentService, info: AgentInfo): string {
  const delegation = info.activity.delegation;
  const state = delegation
    ? `${info.state}, waiting for its helpers ${delegation.graph} (${delegation.done}/${delegation.total} done)`
    : info.activity.tool
      ? `${info.state}, using ${info.activity.tool}`
      : info.state;
  const graph = info.graph ? service.graphById(info.graph) : undefined;
  return `${info.name} (${state}${graph ? `, in graph ${graph.name}` : ""}): ${oneLine(info.task, 120)}`;
}

function graphStatusLine(graph: GraphInfo): string {
  const done = graph.nodes.filter((node) => node.outcome).length;
  return `${graph.name} (graph, ${graph.stopped ? "stopped" : graph.state}, ${done}/${graph.nodes.length} done): ${graphShape(graph)}`;
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
  /** The call's key (see `callKey`); absent when it has no ID. */
  call: string | undefined,
) => Promise<Returned<Static<O>>>;

interface AgentToolSpec<T extends TSchema, O extends TSchema> {
  /** A name `PARENT_TOOL_VIEWS` draws. */
  name: string;
  description: string;
  parameters: T;
  /** The schema of the output scripts get. */
  output: O;
  execute: Execute<T, O>;
}

/**
 * Models sometimes write `wait: false` for "don't wait" or quote numbers.
 * Seconds that aren't a positive number mean no wait; numeric strings count.
 */
export function prepareSeconds(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const prepared: Record<string, unknown> = { ...args };
  for (const key of ["wait", "timeout"]) {
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
    parameters: spec.parameters,
    outputSchema: spec.output,
    prepareArguments: (args) => prepareSeconds(args) as Static<T>,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
          callKey(ctx, toolCallId),
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
 * Wait for agents, streaming their lines as progress for scripts and RPC
 * clients. Progress draws only what the call started, its receipt
 * `started`; the panel shows the live states. The wait ends early when the
 * parent is needed, such as when the user steers, so Pi can place the steer
 * instead of holding it back.
 */
async function waitWithProgress(
  service: AgentService,
  targets: readonly TargetRef[],
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
  call: string | undefined,
  started: ToolReceipt = receipt(),
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
          ...graphs.map(graphStatusLine),
          ...withNodes(service, graphs, agents).map((info) =>
            statusLine(service, info),
          ),
        ].join("\n"),
        { receipt: started },
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
      // The call's result carries the results and names them in its
      // details; nested calls' results aren't stored, so their key counts.
      carrier: call === undefined ? {} : { call },
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

const waitParam = Type.Optional(
  Type.Number({
    description:
      "Block until the agent answers, at most this many seconds, and return its result",
    minimum: 1,
  }),
);

/** What one agent gets: its task and settings. */
const agentFields = {
  task: Type.String({
    description:
      "Self-contained task; the agent does not see this conversation",
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
      description: `Tool allowlist from: ${AGENT_TOOL_NAMES.join(", ")}`,
    }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Skills to load in full instead of the skill catalog; [] for none",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  delegate: Type.Optional(
    Type.Boolean({
      description:
        "Let the agent split its task among helper agents it starts and waits for",
    }),
  ),
};

function describeTarget(service: AgentService, target: Target): string {
  return target.kind === "graph"
    ? graphStatusLine(target.info)
    : statusLine(service, target.info);
}

export function registerAgentTools(pi: ExtensionAPI, host: SessionHost): void {
  const spawnParams = Type.Object({ ...agentFields, wait: waitParam });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn",
      description:
        "Start an agent on a task. Its final message is its result, which arrives later as a message. Set wait to block for the result instead.",
      parameters: spawnParams,
      output: AgentOutput,
      async execute(service, params, ctx, signal, onUpdate, call) {
        const spec = await resolveSpawn(params, ctx, {
          skills: host.skills.get,
          thinking: pi.getThinkingLevel(),
        });
        const info = await service.spawn(spec);
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [{ kind: "agent", id: info.id }],
            params.wait,
            signal,
            onUpdate,
            call,
          );
          return { ...waited, output: agentNow(service, info.id) };
        }
        // The call line already names what it started.
        return {
          content: `Started ${info.name}.`,
          details: { receipt: receipt() },
          output: agentNow(service, info.id),
        };
      },
    }),
  );

  const graphParams = Type.Object({
    name: Type.Optional(
      Type.String({ description: "Short name for the graph" }),
    ),
    agents: Type.Array(
      Type.Object({
        ...agentFields,
        after: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Names of agents in this graph whose final messages this agent needs; it starts once they finished and receives their results",
          }),
        ),
      }),
      {
        minItems: GRAPH_SIZE.min,
        maxItems: GRAPH_SIZE.max,
        description: "One entry per agent",
      },
    ),
    failFast: Type.Optional(
      Type.Boolean({
        description: "Stop the other agents as soon as one fails",
      }),
    ),
    wait: Type.Optional(
      Type.Number({
        description:
          "Block until the graph finishes, at most this many seconds, and return its result",
        minimum: 1,
      }),
    ),
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_spawn_graph",
      description:
        "Start agents that work together on related tasks. Agents run in parallel; one that lists others in after starts once they finished and receives their final messages. The final messages of the agents nothing waits for come back as one message, so to get one merged answer, add an agent after all the others that merges their results. Set wait to block for the result instead.",
      parameters: graphParams,
      output: GraphOutput,
      async execute(service, params, ctx, signal, onUpdate, call) {
        const thinking = pi.getThinkingLevel();
        const graph = await service.spawnGraph({
          ...(params.name ? { name: params.name } : {}),
          ...(params.failFast ? { failFast: true } : {}),
          // Every agent resolves before any starts.
          agents: await Promise.all(
            params.agents.map(async (agent) => ({
              ...(await resolveSpawn(agent, ctx, {
                skills: host.skills.get,
                thinking,
              })),
              ...(agent.after ? { after: agent.after } : {}),
            })),
          ),
        });
        const started = receipt({
          graphs: [startedGraph(graph, lookupAgent(service))],
        });
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [{ kind: "graph", id: graph.id }],
            params.wait,
            signal,
            onUpdate,
            call,
            started,
          );
          return { ...waited, output: graphNow(service, graph.id) };
        }
        return {
          content: `Started graph ${graph.name}: ${graphShape(graph)}.`,
          details: { receipt: started },
          output: graphNow(service, graph.id),
        };
      },
    }),
  );

  const sendParams = Type.Object({
    name: Type.String({ description: "Agent name" }),
    message: Type.String(),
    followUp: Type.Optional(
      Type.Boolean({
        description: "Queue after the current answer instead of steering",
      }),
    ),
    wait: waitParam,
  });
  pi.registerTool(
    defineAgentTool(host, {
      name: "agent_send",
      description:
        "Send a message to an agent, also one that answered or was stopped. A working agent receives it as steering. The answer arrives later as a message. Set wait to block for it instead.",
      parameters: sendParams,
      output: AgentOutput,
      async execute(service, params, _ctx, signal, onUpdate, call) {
        const before = service.get(params.name);
        const sent = await service.send(
          params.name,
          params.message,
          params.followUp ? "followUp" : "auto",
        );
        if (params.wait !== undefined) {
          const waited = await waitWithProgress(
            service,
            [{ kind: "agent", id: sent.id }],
            params.wait,
            signal,
            onUpdate,
            call,
          );
          return { ...waited, output: agentNow(service, sent.id) };
        }
        const info = service.agentById(sent.id) as AgentInfo;
        const verb =
          before?.state === "working"
            ? params.followUp
              ? "Queued for"
              : "Steered"
            : "Sent to";
        return {
          content: `${verb} ${info.name}.`,
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
      description:
        "Block until agents or graphs answer and return their results.",
      parameters: waitParams,
      output: WaitOutput,
      execute: (service, params, _ctx, signal, onUpdate, call) =>
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
          call,
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
      description: "List agents and graphs with their state and task.",
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
          ...graphs.map(graphStatusLine),
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
