import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { discoverAgents, type Scope } from "./agents.js";
import { BudgetActor } from "./budgets.js";
import type { SpawnHandle } from "./engine/interface.js";
import { DelegatedAgentRunError } from "./engine/subprocess.js";
import { AgentEvents } from "./events.js";
import { parseJsonText } from "./flow-spec.js";
import type { AgentManager } from "./manager.js";
import { appendRunEvent } from "./persistence.js";
import type { RunRuntimeState } from "./state.js";
import { applyRunEvent, getRunNodes } from "./state.js";
import type {
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
  RunEvent,
  RunNode,
  RunResultDetails,
  SequenceFlowSpec,
  SequenceNodeResult,
  SpawnFlowSpec,
  SpawnNodeResult,
  WorkflowParams,
  WorkflowRun,
} from "./types.js";

interface FlowMemory {
  readonly bySpecId: Map<string, FlowNodeResult>;
  readonly history: FlowNodeResult[];
}

type ForkFailurePolicy = "failFast" | "collectErrors";

interface EvaluationState {
  runId: string;
  cwd: string;
  scope: Scope;
  parentNodeId?: string;
  depth: number;
  budgets: BudgetActor;
  memory: FlowMemory;
  signal?: AbortSignal;
  createNodeId: (spec: FlowSpec) => string;
  joinFailurePolicies: ReadonlyMap<string, ForkFailurePolicy>;
  handleRegistry: HandleRegistryActor;
}

interface ExecutorOptions {
  pi: ExtensionAPI;
  manager: AgentManager;
  runtimeState: RunRuntimeState;
  onStateChanged?: (ctx: ExtensionContext) => void;
}

export class RunExecutionError extends Error {
  readonly details: RunResultDetails;
  readonly cause: unknown;

  constructor(message: string, details: RunResultDetails, cause?: unknown) {
    super(message);
    this.name = "RunExecutionError";
    this.details = details;
    this.cause = cause;
  }
}

interface HandleRegistryState {
  aborted: boolean;
  handles: Map<string, SpawnHandle>;
}

class HandleRegistryActor {
  private readonly state: HandleRegistryState = {
    aborted: false,
    handles: new Map(),
  };
  private mailbox: Promise<void> = Promise.resolve();

  private send<T>(fn: (state: HandleRegistryState) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mailbox = this.mailbox.then(() => {
        try {
          resolve(fn(this.state));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  spawn(factory: () => SpawnHandle): Promise<SpawnHandle> {
    return this.send((state) => {
      if (state.aborted) {
        throw new Error("Workflow aborted.");
      }
      const handle = factory();
      state.handles.set(handle.id, handle);
      return handle;
    });
  }

  release(handleId: string): Promise<void> {
    return this.send((state) => {
      state.handles.delete(handleId);
    });
  }

  async abortAll(): Promise<void> {
    const handles = await this.send((state) => {
      state.aborted = true;
      return [...state.handles.values()];
    });
    await Promise.all(handles.map((handle) => handle.abort()));
  }
}

interface ForkCoordinatorState {
  cursor: number;
  stopped: boolean;
  controllers: Map<string, AbortController>;
  primaryFailure?: string;
}

class ForkCoordinatorActor {
  private readonly state: ForkCoordinatorState = {
    cursor: 0,
    stopped: false,
    controllers: new Map(),
  };
  private mailbox: Promise<void> = Promise.resolve();

  constructor(
    private readonly entries: ReadonlyArray<readonly [string, FlowSpec]>,
  ) {}

  private send<T>(fn: (state: ForkCoordinatorState) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mailbox = this.mailbox.then(() => {
        try {
          resolve(fn(this.state));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  next(): Promise<readonly [string, FlowSpec] | undefined> {
    return this.send((state) => {
      if (state.stopped) return undefined;
      const entry = this.entries[state.cursor];
      if (!entry) return undefined;
      state.cursor += 1;
      return entry;
    });
  }

  register(key: string, controller: AbortController): Promise<boolean> {
    return this.send((state) => {
      if (state.stopped) return false;
      state.controllers.set(key, controller);
      return true;
    });
  }

  complete(key: string): Promise<void> {
    return this.send((state) => {
      state.controllers.delete(key);
    });
  }

  recordFailure(
    key: string,
    message: string,
  ): Promise<{ primary: boolean; controllers: AbortController[] }> {
    return this.send((state) => {
      state.controllers.delete(key);
      if (state.primaryFailure !== undefined) {
        return { primary: false, controllers: [] };
      }
      state.primaryFailure = message;
      state.stopped = true;
      return {
        primary: true,
        controllers: [...state.controllers.values()],
      };
    });
  }

  primaryFailure(): Promise<string | undefined> {
    return this.send((state) => state.primaryFailure);
  }
}

function collectJoinFailurePolicies(
  flow: FlowSpec,
): ReadonlyMap<string, ForkFailurePolicy> {
  const policies = new Map<string, ForkFailurePolicy>();

  const visit = (spec: FlowSpec) => {
    switch (spec.kind) {
      case "spawn":
        return;
      case "sequence":
        for (const step of spec.steps) visit(step);
        return;
      case "fork":
        for (const branch of Object.values(spec.branches)) visit(branch);
        return;
      case "join": {
        const policy = spec.onFailure ?? "failFast";
        if (policy === "failFast" || !policies.has(spec.from)) {
          policies.set(spec.from, policy);
        }
        return;
      }
      case "loop":
        visit(spec.body);
        return;
    }
  };

  visit(flow);
  return policies;
}

function createLinkedAbortController(parentSignal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!parentSignal) {
    return { controller, dispose: () => undefined };
  }
  if (parentSignal.aborted) {
    controller.abort();
    return { controller, dispose: () => undefined };
  }
  const onAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => parentSignal.removeEventListener("abort", onAbort),
  };
}

function cloneSnapshot<T>(value: T): T {
  return structuredClone(value);
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
    "Workflow context from prior completed steps:",
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
  _memory: FlowMemory,
): unknown {
  if (!spec) return undefined;
  // Resolution priority (first defined value wins):
  //  1. Direct path on the raw body result  (e.g. bodyResult.output.done)
  //  2. Direct path on the summarized body  (e.g. summary.output.done)
  //  3. Walk history in reverse, trying raw then summarized for each entry
  // For simple (non-dotted) paths we also probe candidate.output.<path> so
  // callers can write `path: "done"` instead of `path: "output.done"`.
  const candidates: unknown[] = [bodyResult, summarizeForContext(bodyResult)];

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

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Workflow aborted.");
  }
}

export class RunExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  private emit(event: RunEvent, ctx: ExtensionContext): void {
    applyRunEvent(this.options.runtimeState, event);
    appendRunEvent(this.options.pi, event);

    switch (event.type) {
      case "run_created":
        this.options.pi.events.emit(AgentEvents.RUN_CREATED, {
          runId: event.run.id,
        });
        break;
      case "run_completed":
        this.options.pi.events.emit(
          event.status === "completed"
            ? AgentEvents.RUN_COMPLETED
            : event.status === "failed"
              ? AgentEvents.RUN_FAILED
              : AgentEvents.RUN_ABORTED,
          {
            runId: event.runId,
            status: event.status,
          },
        );
        break;
      case "loop_iteration_completed":
        this.options.pi.events.emit(AgentEvents.RUN_ITERATION, {
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
        });
        break;
      case "node_started":
        if (event.node.kind === "spawn") {
          this.options.pi.events.emit(AgentEvents.AGENTS_SPAWNED, {
            runId: event.node.runId,
            nodeId: event.node.id,
          });
        }
        break;
      case "node_completed":
        this.options.pi.events.emit(AgentEvents.AGENTS_COMPLETED, {
          runId: event.runId,
          nodeId: event.nodeId,
        });
        break;
      case "node_failed":
        this.options.pi.events.emit(AgentEvents.AGENTS_FAILED, {
          runId: event.runId,
          nodeId: event.nodeId,
          error: event.error,
        });
        break;
      default:
        break;
    }

    this.options.onStateChanged?.(ctx);
  }

  private buildSnapshot(runId: string): RunResultDetails {
    const run = this.options.runtimeState.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown run ${runId}.`);
    }
    return cloneSnapshot({
      run,
      nodes: getRunNodes(this.options.runtimeState, runId),
      result: run.result,
    });
  }

  async execute(
    params: WorkflowParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<RunResultDetails>) => void,
  ): Promise<RunResultDetails> {
    const runId = crypto.randomUUID();
    let nodeCounter = 0;
    const createNodeId = (spec: FlowSpec): string => {
      nodeCounter += 1;
      const prefix = spec.id ?? spec.kind;
      return `${prefix}:${nodeCounter}`;
    };
    const rootNodeId = createNodeId(params.flow);
    const flow = params.flow;
    const run: WorkflowRun = {
      id: runId,
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

    const handleRegistry = new HandleRegistryActor();

    const notifyUpdate = () => {
      if (!onUpdate) return;
      const snapshot = this.buildSnapshot(runId);
      const summary = snapshot.result
        ? formatOutputSummary(summarizeForContext(snapshot.result))
        : `${snapshot.nodes.length} nodes tracked`;
      onUpdate({
        content: [{ type: "text", text: summary }],
        details: snapshot,
      });
    };

    const onAbort = () => {
      void handleRegistry.abortAll();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    this.emit({ type: "run_created", at: run.startedAt, run }, ctx);
    notifyUpdate();

    const initialState: EvaluationState = {
      runId,
      cwd: run.cwd,
      scope: run.scope,
      depth: 1,
      budgets: new BudgetActor(params.budgets),
      memory: {
        bySpecId: new Map(),
        history: [],
      },
      signal,
      createNodeId,
      joinFailurePolicies: collectJoinFailurePolicies(flow),
      handleRegistry,
    };

    try {
      const result = await this.evaluateFlow(
        flow,
        {
          ...initialState,
          parentNodeId: undefined,
        },
        ctx,
        notifyUpdate,
        rootNodeId,
      );
      this.emit(
        {
          type: "run_completed",
          at: Date.now(),
          runId,
          status: "completed",
          result,
        },
        ctx,
      );
      notifyUpdate();
      return this.buildSnapshot(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = signal?.aborted || message.includes("aborted");
      this.emit(
        {
          type: "run_completed",
          at: Date.now(),
          runId,
          status: aborted ? "aborted" : "failed",
          error: message,
        },
        ctx,
      );
      notifyUpdate();
      throw new RunExecutionError(message, this.buildSnapshot(runId), error);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  private async evaluateFlow(
    spec: FlowSpec,
    state: EvaluationState,
    ctx: ExtensionContext,
    notifyUpdate: () => void,
    forcedNodeId?: string,
    branchKey?: string,
    iteration?: number,
  ): Promise<FlowNodeResult> {
    assertNotAborted(state.signal);

    const nodeId = forcedNodeId ?? state.createNodeId(spec);
    const node: RunNode = {
      id: nodeId,
      runId: state.runId,
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
          result = await this.evaluateSpawn(spec, nodeId, state, ctx);
          break;
        case "sequence":
          result = await this.evaluateSequence(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
          );
          break;
        case "fork":
          result = await this.evaluateFork(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
          );
          break;
        case "join":
          result = await this.evaluateJoin(spec, nodeId, state, ctx);
          break;
        case "loop":
          result = await this.evaluateLoop(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
          );
          break;
      }

      this.emit(
        {
          type: "node_completed",
          at: Date.now(),
          runId: state.runId,
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
          runId: state.runId,
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
  ): Promise<SpawnNodeResult> {
    assertNotAborted(state.signal);
    await state.budgets.acquireSpawn(state.depth);
    assertNotAborted(state.signal);

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
    const budgetLimits = await state.budgets.limits();
    assertNotAborted(state.signal);
    const handle = await state.handleRegistry.spawn(() =>
      this.options.manager.spawn(
        {
          agent,
          task,
          cwd,
          scope,
          discoveryDiagnostics: diagnostics,
          runId: state.runId,
          parentNodeId: nodeId,
          depth: state.depth,
          env: {
            PI_RUN_ID: state.runId,
            PI_RUN_NODE_ID: nodeId,
            PI_RUN_DEPTH: String(state.depth),
            PI_RUN_BUDGETS: JSON.stringify(budgetLimits),
          },
        },
        ctx,
      ),
    );
    const onAbort = () => {
      void handle.abort();
    };
    if (state.signal) {
      if (state.signal.aborted) onAbort();
      else state.signal.addEventListener("abort", onAbort, { once: true });
    }

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
      if (state.signal) state.signal.removeEventListener("abort", onAbort);
      await state.handleRegistry.release(handle.id);
    }
  }

  private async evaluateSequence(
    spec: SequenceFlowSpec,
    nodeId: string,
    state: EvaluationState,
    ctx: ExtensionContext,
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
    notifyUpdate: () => void,
  ): Promise<ForkNodeResult> {
    this.emit(
      {
        type: "node_waiting",
        at: Date.now(),
        runId: state.runId,
        nodeId,
        status: "waiting",
      },
      ctx,
    );

    const entries = Object.entries(spec.branches) as Array<[string, FlowSpec]>;
    const concurrency = await state.budgets.getParallelismLimit(
      spec.concurrency,
    );
    const failurePolicy =
      state.joinFailurePolicies.get(spec.id) ?? "collectErrors";
    const coordinator = new ForkCoordinatorActor(entries);
    const workerCount = Math.max(1, Math.min(concurrency, entries.length));
    const workerResults = await Promise.all(
      Array.from({ length: workerCount }, async () => {
        const results: ForkBranchResult[] = [];
        while (true) {
          const entry = await coordinator.next();
          if (!entry) return results;

          const [key, branchSpec] = entry;
          const { controller, dispose } = createLinkedAbortController(
            state.signal,
          );
          const registered = await coordinator.register(key, controller);
          if (!registered) {
            controller.abort();
            dispose();
            return results;
          }

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
                signal: controller.signal,
              },
              ctx,
              notifyUpdate,
              undefined,
              key,
            );
            results.push({
              branchKey: key,
              result,
            } satisfies ForkBranchResult);
            await coordinator.complete(key);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            results.push({
              branchKey: key,
              error: message,
            } satisfies ForkBranchResult);
            if (failurePolicy === "failFast") {
              const { controllers } = await coordinator.recordFailure(
                key,
                message,
              );
              for (const sibling of controllers) {
                sibling.abort();
              }
            } else {
              await coordinator.complete(key);
            }
          } finally {
            dispose();
          }
        }
      }),
    );

    assertNotAborted(state.signal);

    const branchResults = workerResults.flat();
    const primaryFailure = await coordinator.primaryFailure();
    if (failurePolicy === "failFast" && primaryFailure) {
      throw new Error(primaryFailure);
    }

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
  ): Promise<JoinNodeResult> {
    const forkResult = state.memory.bySpecId.get(spec.from);
    if (!forkResult || forkResult.kind !== "fork") {
      throw new Error(`Join could not find fork "${spec.from}" in this run.`);
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
            `Join(all) failed because ${failureEntries.length} branch(es) failed: ${failureEntries
              .map(
                ([key, value]) => `${key}: ${value.error ?? "unknown error"}`,
              )
              .join("; ")}`,
          );
        }
        break;
      case "any": {
        const first = successEntries[0];
        if (!first) {
          throw new Error(
            "Join(any) failed because no branch completed successfully.",
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
    this.options.pi.events.emit(AgentEvents.AGENTS_JOINED, {
      runId: state.runId,
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
    notifyUpdate: () => void,
  ): Promise<LoopNodeResult> {
    const iterations: FlowNodeResult[] = [];
    const loopMemory = cloneMemory(state.memory);
    const iterationLimit = await state.budgets.getLoopIterationLimit(
      spec.maxIterations,
    );
    let latestOutput: unknown;

    for (let iteration = 1; iteration <= iterationLimit; iteration++) {
      this.emit(
        {
          type: "loop_iteration_started",
          at: Date.now(),
          runId: state.runId,
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
          runId: state.runId,
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
