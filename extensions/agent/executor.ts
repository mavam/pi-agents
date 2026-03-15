import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { discoverAgents, type Scope } from "./agents.js";
import {
  assertDepth,
  type BudgetSnapshot,
  consumeChild,
  createBudgetSnapshot,
  getLoopIterationLimit,
  getParallelismLimit,
} from "./budgets.js";
import type { SpawnHandle } from "./engine/interface.js";
import { DelegatedAgentRunError } from "./engine/subprocess.js";
import { parseJsonText } from "./flow-spec.js";
import { type AgentManager, mapWithConcurrencyLimit } from "./manager.js";
import { appendCompositionEvent } from "./persistence.js";
import type { CompositionRuntimeState } from "./state.js";
import { applyCompositionEvent, getCompositionNodes } from "./state.js";
import type {
  ComposeParams,
  CompositionEvent,
  CompositionNode,
  CompositionResultDetails,
  CompositionRun,
  ContinueSpec,
  FlowNodeResult,
  FlowSpec,
  ForkBranchResult,
  ForkFlowSpec,
  ForkNodeResult,
  JoinFlowSpec,
  JoinNodeResult,
  LoopFlowSpec,
  LoopNodeResult,
  SequenceFlowSpec,
  SequenceNodeResult,
  SpawnFlowSpec,
  SpawnNodeResult,
} from "./types.js";

interface FlowMemory {
  readonly bySpecId: Map<string, FlowNodeResult>;
  readonly history: FlowNodeResult[];
}

interface EvaluationState {
  compositionId: string;
  cwd: string;
  scope: Scope;
  parentNodeId?: string;
  depth: number;
  budgets: BudgetSnapshot;
  memory: FlowMemory;
}

interface ExecutorOptions {
  pi: ExtensionAPI;
  manager: AgentManager;
  runtimeState: CompositionRuntimeState;
  onStateChanged?: (ctx: ExtensionContext) => void;
}

export class CompositionExecutionError extends Error {
  readonly details: CompositionResultDetails;

  constructor(message: string, details: CompositionResultDetails) {
    super(message);
    this.name = "CompositionExecutionError";
    this.details = details;
  }
}

function toDiagnosticText(
  scope: Scope,
  diagnostics: Array<{ filePath: string; message: string }>,
): string[] {
  const prefix = `scope=${scope}`;
  return diagnostics.map((d) => `${prefix}: ${d.filePath}: ${d.message}`);
}

function cloneMemory(memory: FlowMemory): FlowMemory {
  return {
    bySpecId: new Map(memory.bySpecId),
    history: [...memory.history],
  };
}

function rememberResult(
  spec: FlowSpec,
  result: FlowNodeResult,
  memory: FlowMemory,
): void {
  if (spec.id) memory.bySpecId.set(spec.id, result);
  memory.history.push(result);
}

function getPathValue(value: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function summarizeForContext(result: FlowNodeResult): unknown {
  switch (result.kind) {
    case "spawn":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        agent: result.agent,
        text: result.text,
        output: result.output,
      };
    case "sequence":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        output: result.output,
        steps: result.steps.map((step) => summarizeForContext(step)),
      };
    case "fork":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        branches: Object.fromEntries(
          Object.entries(result.branches).map(([key, branch]) => [
            key,
            branch.result
              ? summarizeForContext(branch.result)
              : { error: branch.error },
          ]),
        ),
        output: result.output,
      };
    case "join":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        selectedBranches: result.selectedBranches,
        output: result.output,
      };
    case "loop":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        iterations: result.iterations.map((item) => summarizeForContext(item)),
        output: result.output,
      };
  }
}

function buildDelegatedTask(task: string, memory: FlowMemory): string {
  if (memory.history.length === 0) return task;
  const latest = memory.history[memory.history.length - 1];
  const nodes = Object.fromEntries(
    [...memory.bySpecId.entries()].map(([key, value]) => [
      key,
      summarizeForContext(value),
    ]),
  );
  const payload = {
    latest: latest ? summarizeForContext(latest) : undefined,
    nodes,
  };
  return [
    task,
    "",
    "Composition context from prior completed steps:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

function resolveStructuredOutput(
  outputMode: "text" | "json" | undefined,
  text: string,
): unknown {
  if (outputMode === "json") return parseJsonText(text);
  return text;
}

function resolveContinueValue(
  spec: ContinueSpec | undefined,
  bodyResult: FlowNodeResult,
  memory: FlowMemory,
): unknown {
  if (!spec) return undefined;
  const candidates: unknown[] = [
    bodyResult,
    summarizeForContext(bodyResult),
    ...memory.history
      .slice()
      .reverse()
      .flatMap((item) => [item, summarizeForContext(item)]),
  ];

  for (const candidate of candidates) {
    const direct = getPathValue(candidate, spec.path);
    if (direct !== undefined) return direct;
    if (
      !spec.path.includes(".") &&
      typeof candidate === "object" &&
      candidate !== null
    ) {
      const output = (candidate as Record<string, unknown>).output;
      const nested = getPathValue(output, spec.path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function formatOutputSummary(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export class CompositionExecutor {
  private nodeCounter = 0;

  constructor(private readonly options: ExecutorOptions) {}

  private emit(event: CompositionEvent, ctx: ExtensionContext): void {
    applyCompositionEvent(this.options.runtimeState, event);
    appendCompositionEvent(this.options.pi, event);

    switch (event.type) {
      case "composition_created":
        this.options.pi.events.emit("composition:created", {
          compositionId: event.composition.id,
        });
        break;
      case "composition_completed":
        this.options.pi.events.emit(`composition:${event.status}`, {
          compositionId: event.compositionId,
          status: event.status,
        });
        break;
      case "loop_iteration_completed":
        this.options.pi.events.emit("composition:iteration", {
          compositionId: event.compositionId,
          nodeId: event.nodeId,
          iteration: event.iteration,
        });
        break;
      case "node_started":
        if (event.node.kind === "spawn") {
          this.options.pi.events.emit("agents:spawned", {
            compositionId: event.node.compositionId,
            nodeId: event.node.id,
          });
        }
        break;
      case "node_completed":
        this.options.pi.events.emit("agents:completed", {
          compositionId: event.compositionId,
          nodeId: event.nodeId,
        });
        break;
      case "node_failed":
        this.options.pi.events.emit("agents:failed", {
          compositionId: event.compositionId,
          nodeId: event.nodeId,
          error: event.error,
        });
        break;
      default:
        break;
    }

    this.options.onStateChanged?.(ctx);
  }

  private buildSnapshot(compositionId: string): CompositionResultDetails {
    const composition = this.options.runtimeState.runs.get(compositionId);
    if (!composition) {
      throw new Error(`Unknown composition ${compositionId}.`);
    }
    return {
      composition,
      nodes: getCompositionNodes(this.options.runtimeState, compositionId),
      result: composition.result,
    };
  }

  private createNodeId(spec: FlowSpec): string {
    this.nodeCounter += 1;
    const prefix = spec.id ?? spec.kind;
    return `${prefix}:${this.nodeCounter}`;
  }

  async execute(
    params: ComposeParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<CompositionResultDetails>) => void,
  ): Promise<CompositionResultDetails> {
    const compositionId = crypto.randomUUID();
    const rootNodeId = this.createNodeId(params.flow);
    const flow = params.flow;
    const composition: CompositionRun = {
      id: compositionId,
      rootNodeId,
      label: params.label ?? flow.label ?? flow.kind,
      status: "running",
      startedAt: Date.now(),
      depth: 0,
      flow,
      budgets: params.budgets,
      cwd: params.cwd ?? ctx.cwd,
      scope: params.scope ?? "both",
    };

    const activeHandles = new Set<SpawnHandle>();
    const abortActive = async () => {
      await Promise.all([...activeHandles].map((handle) => handle.abort()));
    };

    const notifyUpdate = () => {
      if (!onUpdate) return;
      const snapshot = this.buildSnapshot(compositionId);
      const summary = snapshot.result
        ? formatOutputSummary(summarizeForContext(snapshot.result))
        : `${snapshot.nodes.length} nodes tracked`;
      onUpdate({
        content: [{ type: "text", text: summary }],
        details: snapshot,
      });
    };

    const onAbort = () => {
      void abortActive();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    this.emit(
      { type: "composition_created", at: composition.startedAt, composition },
      ctx,
    );
    notifyUpdate();

    const initialState: EvaluationState = {
      compositionId,
      cwd: composition.cwd,
      scope: composition.scope,
      depth: 1,
      budgets: createBudgetSnapshot(params.budgets),
      memory: {
        bySpecId: new Map(),
        history: [],
      },
    };

    try {
      const result = await this.evaluateFlow(
        flow,
        {
          ...initialState,
          parentNodeId: undefined,
        },
        ctx,
        activeHandles,
        notifyUpdate,
        rootNodeId,
      );
      const completedAt = Date.now();
      this.emit(
        {
          type: "composition_completed",
          at: completedAt,
          compositionId,
          status: "completed",
          result,
        },
        ctx,
      );
      notifyUpdate();
      return this.buildSnapshot(compositionId);
    } catch (error) {
      const completedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      const aborted = signal?.aborted || message.includes("aborted");
      this.emit(
        {
          type: "composition_completed",
          at: completedAt,
          compositionId,
          status: aborted ? "aborted" : "failed",
          error: message,
        },
        ctx,
      );
      notifyUpdate();
      throw new CompositionExecutionError(
        message,
        this.buildSnapshot(compositionId),
      );
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  private async evaluateFlow(
    spec: FlowSpec,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
    notifyUpdate: () => void,
    forcedNodeId?: string,
    branchKey?: string,
    iteration?: number,
  ): Promise<FlowNodeResult> {
    const nodeId = forcedNodeId ?? this.createNodeId(spec);
    const node: CompositionNode = {
      id: nodeId,
      compositionId: state.compositionId,
      parentNodeId: state.parentNodeId,
      specId: spec.id,
      kind: spec.kind,
      label: spec.label,
      status: "running",
      branchKey,
      iteration,
      startedAt: Date.now(),
    };
    this.emit({ type: "node_started", at: Date.now(), node }, ctx);
    notifyUpdate();

    try {
      let result: FlowNodeResult;
      switch (spec.kind) {
        case "spawn":
          result = await this.evaluateSpawn(
            spec,
            nodeId,
            state,
            ctx,
            activeHandles,
          );
          break;
        case "sequence":
          result = await this.evaluateSequence(
            spec,
            nodeId,
            state,
            ctx,
            activeHandles,
            notifyUpdate,
          );
          break;
        case "fork":
          result = await this.evaluateFork(
            spec,
            nodeId,
            state,
            ctx,
            activeHandles,
            notifyUpdate,
          );
          break;
        case "join":
          result = await this.evaluateJoin(
            spec,
            nodeId,
            state,
            ctx,
            activeHandles,
          );
          break;
        case "loop":
          result = await this.evaluateLoop(
            spec,
            nodeId,
            state,
            ctx,
            activeHandles,
            notifyUpdate,
          );
          break;
      }

      this.emit(
        {
          type: "node_completed",
          at: Date.now(),
          compositionId: state.compositionId,
          nodeId,
          output: summarizeForContext(result),
        },
        ctx,
      );
      notifyUpdate();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(
        {
          type: message.includes("aborted") ? "node_aborted" : "node_failed",
          at: Date.now(),
          compositionId: state.compositionId,
          nodeId,
          error: message,
        },
        ctx,
      );
      notifyUpdate();
      throw error;
    }
  }

  private async evaluateSpawn(
    spec: SpawnFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
  ): Promise<SpawnNodeResult> {
    assertDepth(state.budgets, state.depth);
    consumeChild(state.budgets);

    const scope = spec.scope ?? state.scope;
    const cwd = spec.cwd ?? state.cwd;
    const discovery = discoverAgents(cwd, scope);
    const diagnostics = toDiagnosticText(scope, discovery.diagnostics);
    const agent = discovery.agents.find(
      (candidate) => candidate.name === spec.agent,
    );
    if (!agent) {
      throw new Error(
        `Unknown agent "${spec.agent}" for scope=${scope}. Available: ${discovery.agents.map((item) => item.name).join(", ") || "none"}`,
      );
    }

    const task = buildDelegatedTask(spec.task, state.memory);
    const handle = this.options.manager.spawn(
      {
        agent,
        task,
        cwd,
        scope,
        discoveryDiagnostics: diagnostics,
        compositionId: state.compositionId,
        parentNodeId: nodeId,
        depth: state.depth,
        env: {
          PI_COMPOSITION_ID: state.compositionId,
          PI_COMPOSITION_NODE_ID: nodeId,
          PI_COMPOSITION_DEPTH: String(state.depth),
          PI_COMPOSITION_BUDGETS: JSON.stringify(state.budgets.limits),
        },
      },
      ctx,
    );
    activeHandles.add(handle);

    try {
      const spawnResult = await handle.wait();
      const output = resolveStructuredOutput(spec.output, spawnResult.text);
      const result: SpawnNodeResult = {
        nodeId,
        specId: spec.id,
        kind: "spawn",
        status: "completed",
        text: spawnResult.text,
        output,
        agent: spec.agent,
        run: spawnResult.details,
      };
      rememberResult(spec, result, state.memory);
      return result;
    } catch (error) {
      if (error instanceof DelegatedAgentRunError) {
        throw error;
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      activeHandles.delete(handle);
    }
  }

  private async evaluateSequence(
    spec: SequenceFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
    notifyUpdate: () => void,
  ): Promise<SequenceNodeResult> {
    const steps: FlowNodeResult[] = [];
    const memory = cloneMemory(state.memory);
    let latestOutput: unknown;

    for (const step of spec.steps) {
      const result = await this.evaluateFlow(
        step,
        {
          ...state,
          parentNodeId: nodeId,
          depth: state.depth + 1,
          budgets: state.budgets,
          memory,
        },
        ctx,
        activeHandles,
        notifyUpdate,
      );
      steps.push(result);
      latestOutput = result.output;
    }

    const sequenceResult: SequenceNodeResult = {
      nodeId,
      specId: spec.id,
      kind: "sequence",
      status: "completed",
      steps,
      output: latestOutput,
    };
    rememberResult(spec, sequenceResult, state.memory);
    return sequenceResult;
  }

  private async evaluateFork(
    spec: ForkFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
    notifyUpdate: () => void,
  ): Promise<ForkNodeResult> {
    this.emit(
      {
        type: "node_waiting",
        at: Date.now(),
        compositionId: state.compositionId,
        nodeId,
        status: "waiting",
      },
      ctx,
    );

    const entries = Object.entries(spec.branches);
    const concurrency = getParallelismLimit(state.budgets, spec.concurrency);
    const branchResults = await mapWithConcurrencyLimit(
      entries,
      concurrency,
      async ([key, branchSpec]) => {
        const branchMemory = cloneMemory(state.memory);
        try {
          const result = await this.evaluateFlow(
            branchSpec,
            {
              ...state,
              parentNodeId: nodeId,
              depth: state.depth + 1,
              budgets: state.budgets,
              memory: branchMemory,
            },
            ctx,
            activeHandles,
            notifyUpdate,
            undefined,
            key,
          );
          return {
            branchKey: key,
            result,
          } satisfies ForkBranchResult;
        } catch (error) {
          return {
            branchKey: key,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ForkBranchResult;
        }
      },
    );

    const branches = Object.fromEntries(
      branchResults.map((result) => [result.branchKey, result]),
    );
    const output = {
      branches: Object.fromEntries(
        branchResults
          .filter((item) => item.result)
          .map((item) => [item.branchKey, item.result?.output]),
      ),
      errors: Object.fromEntries(
        branchResults
          .filter((item) => item.error)
          .map((item) => [item.branchKey, item.error ?? "unknown error"]),
      ),
    };

    const forkResult: ForkNodeResult = {
      nodeId,
      specId: spec.id,
      kind: "fork",
      status: "completed",
      branches,
      output,
    };
    rememberResult(spec, forkResult, state.memory);
    return forkResult;
  }

  private async evaluateJoin(
    spec: JoinFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
  ): Promise<JoinNodeResult> {
    const forkResult = state.memory.bySpecId.get(spec.from);
    if (!forkResult || forkResult.kind !== "fork") {
      throw new Error(
        `Join could not find fork "${spec.from}" in this composition.`,
      );
    }

    const successEntries = Object.entries(forkResult.branches).filter(
      ([, value]) => value.result,
    ) as Array<[string, { result: FlowNodeResult; error?: string }]>;
    const failureEntries = Object.entries(forkResult.branches).filter(
      ([, value]) => !value.result,
    );

    let selected: Array<[string, FlowNodeResult]>;
    switch (spec.mode) {
      case "all":
        selected = successEntries.map(([key, value]) => [key, value.result]);
        if (
          failureEntries.length > 0 &&
          (spec.onFailure ?? "failFast") === "failFast"
        ) {
          throw new Error(
            `Join(all) failed because ${failureEntries.length} branch(es) failed: ${failureEntries.map(([key, value]) => `${key}: ${value.error ?? "unknown error"}`).join("; ")}`,
          );
        }
        break;
      case "any": {
        const first = successEntries[0];
        if (!first) {
          throw new Error(
            `Join(any) failed because no branch completed successfully.`,
          );
        }
        selected = [[first[0], first[1].result]];
        break;
      }
      case "quorum": {
        const quorum = spec.quorum ?? 0;
        if (successEntries.length < quorum) {
          throw new Error(
            `Join(quorum=${quorum}) failed because only ${successEntries.length} branch(es) succeeded.`,
          );
        }
        selected = successEntries
          .slice(0, quorum)
          .map(([key, value]) => [key, value.result]);
        break;
      }
    }

    let output: unknown;
    if (!spec.reducer || spec.reducer.kind === "collect") {
      output = {
        branches: Object.fromEntries(
          selected.map(([key, value]) => [key, value.output]),
        ),
        errors: Object.fromEntries(
          failureEntries.map(([key, value]) => [
            key,
            value.error ?? "unknown error",
          ]),
        ),
      };
    } else {
      const reducerMemory = cloneMemory(state.memory);
      const reducerTask = [
        spec.reducer.task,
        "",
        "Join inputs:",
        "```json",
        JSON.stringify(
          {
            selectedBranches: Object.fromEntries(
              selected.map(([key, value]) => [key, summarizeForContext(value)]),
            ),
            failedBranches: Object.fromEntries(
              failureEntries.map(([key, value]) => [
                key,
                value.error ?? "unknown error",
              ]),
            ),
          },
          null,
          2,
        ),
        "```",
      ].join("\n");
      const reducerSpawn = await this.evaluateSpawn(
        {
          kind: "spawn",
          id: spec.id ? `${spec.id}:reducer` : undefined,
          label: spec.label ? `${spec.label} reducer` : undefined,
          agent: spec.reducer.agent,
          task: reducerTask,
          output: spec.reducer.output,
        },
        `${nodeId}:reducer`,
        {
          ...state,
          parentNodeId: nodeId,
          depth: state.depth + 1,
          memory: reducerMemory,
        },
        ctx,
        activeHandles,
      );
      output = reducerSpawn.output;
    }

    const joinResult: JoinNodeResult = {
      nodeId,
      specId: spec.id,
      kind: "join",
      status: "completed",
      selectedBranches: selected.map(([key]) => key),
      output,
    };
    rememberResult(spec, joinResult, state.memory);
    this.options.pi.events.emit("agents:joined", {
      compositionId: state.compositionId,
      nodeId,
      from: spec.from,
    });
    return joinResult;
  }

  private async evaluateLoop(
    spec: LoopFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
    activeHandles: Set<SpawnHandle>,
    notifyUpdate: () => void,
  ): Promise<LoopNodeResult> {
    const iterations: FlowNodeResult[] = [];
    const loopMemory = cloneMemory(state.memory);
    const iterationLimit = getLoopIterationLimit(
      state.budgets,
      spec.maxIterations,
    );
    let latestOutput: unknown;

    for (let iteration = 1; iteration <= iterationLimit; iteration++) {
      this.emit(
        {
          type: "loop_iteration_started",
          at: Date.now(),
          compositionId: state.compositionId,
          nodeId,
          iteration,
        },
        ctx,
      );
      notifyUpdate();

      const bodyResult = await this.evaluateFlow(
        spec.body,
        {
          ...state,
          parentNodeId: nodeId,
          depth: state.depth + 1,
          budgets: state.budgets,
          memory: loopMemory,
        },
        ctx,
        activeHandles,
        notifyUpdate,
        undefined,
        undefined,
        iteration,
      );
      iterations.push(bodyResult);
      latestOutput = bodyResult.output;

      this.emit(
        {
          type: "loop_iteration_completed",
          at: Date.now(),
          compositionId: state.compositionId,
          nodeId,
          iteration,
        },
        ctx,
      );
      notifyUpdate();

      if (!spec.continueWhen) break;
      const continueValue = resolveContinueValue(
        spec.continueWhen,
        bodyResult,
        loopMemory,
      );
      if (continueValue !== spec.continueWhen.equals) break;
    }

    const loopResult: LoopNodeResult = {
      nodeId,
      specId: spec.id,
      kind: "loop",
      status: "completed",
      iterations,
      output: latestOutput,
    };
    rememberResult(spec, loopResult, state.memory);
    return loopResult;
  }
}
