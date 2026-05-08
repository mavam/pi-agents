import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  resolveAgentByName,
  type Scope,
  type Thinking,
} from "../catalog/agents.js";
import { toDiagnosticText } from "../catalog/diagnostics.js";
import type { SpawnHandle } from "../engine/interface.js";
import {
  forkBranchPath,
  loopBodyPath,
  ROOT_FLOW_PATH,
  sequenceStepPath,
} from "../workflow/flow-path.js";
import { parseJsonText } from "../workflow/flow-spec.js";
import { BudgetActor } from "./budgets.js";
import { AgentEvents } from "./events.js";
import type { AgentManager } from "./manager.js";
import { appendRunEvent } from "./persistence.js";
import type { RunRuntimeState } from "./state.js";
import { applyRunEvent, getRunSnapshot } from "./state.js";
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

interface ForkJoinPlan {
  mode: JoinFlowSpec["mode"];
  quorum?: number;
  onFailure: ForkFailurePolicy;
}

interface EvaluationState {
  runId: string;
  cwd: string;
  scope: Scope;
  defaultModel?: string;
  defaultThinking?: Thinking;
  parentNodeId?: string;
  depth: number;
  budgets: BudgetActor;
  memory: FlowMemory;
  signal?: AbortSignal;
  createNodeId: (spec: FlowSpec) => string;
  joinPlans: ReadonlyMap<string, ForkJoinPlan>;
  handleRegistry: HandleRegistryActor;
}

interface ExecutorOptions {
  pi: ExtensionAPI;
  manager: AgentManager;
  runtimeState: RunRuntimeState;
  onStateChanged?: (ctx: ExtensionContext) => void;
}

export interface RunExecutionControls {
  appendEvent?: (event: RunEvent) => void;
  onRunCreated?: (runId: string) => void;
  onEvent?: (event: RunEvent) => void;
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

type ForkStopKind = "success" | "failure" | "impossible";

interface ForkCoordinatorState {
  cursor: number;
  stopped: boolean;
  controllers: Map<string, AbortController>;
  outcomes: ForkBranchResult[];
  successes: number;
  failures: number;
  primaryFailure?: string;
  stopKind?: ForkStopKind;
}

class ForkCoordinatorActor {
  private readonly state: ForkCoordinatorState = {
    cursor: 0,
    stopped: false,
    controllers: new Map(),
    outcomes: [],
    successes: 0,
    failures: 0,
  };
  private readonly desiredSuccesses: number;
  private readonly failurePolicy: ForkFailurePolicy;
  private readonly shortCircuitOnSuccess: boolean;
  private mailbox: Promise<void> = Promise.resolve();

  constructor(
    private readonly entries: ReadonlyArray<readonly [string, FlowSpec]>,
    plan?: ForkJoinPlan,
  ) {
    this.failurePolicy = plan?.onFailure ?? "collectErrors";
    this.shortCircuitOnSuccess = plan !== undefined && plan.mode !== "all";
    this.desiredSuccesses =
      plan?.mode === "any"
        ? 1
        : plan?.mode === "quorum"
          ? (plan.quorum ?? 0)
          : entries.length;
  }

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

  recordSuccess(
    key: string,
    result: FlowNodeResult,
  ): Promise<AbortController[]> {
    return this.send((state) => {
      state.controllers.delete(key);
      state.outcomes.push({
        branchKey: key,
        result,
      } satisfies ForkBranchResult);

      if (state.stopKind) {
        return [];
      }

      state.successes += 1;
      if (
        !this.shortCircuitOnSuccess ||
        state.successes < this.desiredSuccesses
      ) {
        return [];
      }

      state.stopped = true;
      state.stopKind = "success";
      return [...state.controllers.values()];
    });
  }

  recordFailure(
    key: string,
    message: string,
  ): Promise<{ controllers: AbortController[]; primaryFailure?: string }> {
    return this.send((state) => {
      state.controllers.delete(key);
      state.outcomes.push({
        branchKey: key,
        error: message,
      } satisfies ForkBranchResult);

      if (state.stopKind) {
        return { controllers: [], primaryFailure: state.primaryFailure };
      }

      state.failures += 1;
      if (this.failurePolicy === "failFast") {
        state.stopped = true;
        state.stopKind = "failure";
        state.primaryFailure = message;
        return {
          controllers: [...state.controllers.values()],
          primaryFailure: state.primaryFailure,
        };
      }

      const remainingPotential =
        this.entries.length - state.successes - state.failures;
      if (
        this.shortCircuitOnSuccess &&
        state.successes + remainingPotential < this.desiredSuccesses
      ) {
        state.stopped = true;
        state.stopKind = "impossible";
        return { controllers: [...state.controllers.values()] };
      }

      return { controllers: [] };
    });
  }

  stopReason(): Promise<ForkStopKind | undefined> {
    return this.send((state) => state.stopKind);
  }

  getPrimaryFailure(): Promise<string | undefined> {
    return this.send((state) => state.primaryFailure);
  }

  outcomes(): Promise<ForkBranchResult[]> {
    return this.send((state) => [...state.outcomes]);
  }
}

function collectJoinPlans(flow: FlowSpec): ReadonlyMap<string, ForkJoinPlan> {
  const plans = new Map<string, ForkJoinPlan>();

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
      case "join":
        plans.set(spec.from, {
          mode: spec.mode,
          quorum: spec.quorum,
          onFailure: spec.onFailure ?? "failFast",
        });
        return;
      case "loop":
        visit(spec.body);
        return;
    }
  };

  visit(flow);
  return plans;
}

type WorkflowAgentIssue =
  | {
      kind: "missing";
      specPath: string;
      agent: string;
      cwd: string;
      scope: Scope;
      available: string[];
    }
  | {
      kind: "ambiguous";
      specPath: string;
      agent: string;
      cwd: string;
      scope: Scope;
      matches: string[];
    };

function formatWorkflowAgentIssues(issues: WorkflowAgentIssue[]): string {
  const hasOnlyMissing = issues.every((issue) => issue.kind === "missing");
  const lines = [
    hasOnlyMissing
      ? "Unknown workflow agents:"
      : "Invalid workflow agent references:",
  ];

  for (const issue of issues) {
    if (issue.kind === "missing") {
      lines.push(
        `- ${issue.specPath}: "${issue.agent}" is not valid for scope=${issue.scope} cwd=${issue.cwd}.`,
      );
      if (issue.available.length > 0) {
        lines.push(`  Available: ${issue.available.join(", ")}`);
      }
      continue;
    }

    lines.push(
      `- ${issue.specPath}: "${issue.agent}" is ambiguous ignoring case for scope=${issue.scope} cwd=${issue.cwd}. Matches: ${issue.matches.join(", ")}`,
    );
  }

  return lines.join("\n");
}

function preflightWorkflowAgents(
  flow: FlowSpec,
  defaults: { cwd: string; scope: Scope },
): void {
  const discoveryCache = new Map<string, ReturnType<typeof discoverAgents>>();
  const issues: WorkflowAgentIssue[] = [];

  const getDiscovery = (cwd: string, scope: Scope) => {
    const key = `${scope}\u0000${cwd}`;
    let discovery = discoveryCache.get(key);
    if (!discovery) {
      discovery = discoverAgents(cwd, scope);
      discoveryCache.set(key, discovery);
    }
    return discovery;
  };

  const validateAgentReference = (
    agent: string,
    specPath: string,
    cwd: string,
    scope: Scope,
    applyResolvedName: (name: string) => void,
  ) => {
    const discovery = getDiscovery(cwd, scope);
    const resolvedAgent = resolveAgentByName(discovery.agents, agent);

    switch (resolvedAgent.kind) {
      case "exact":
        return;
      case "case_insensitive":
        applyResolvedName(resolvedAgent.agent.name);
        return;
      case "missing":
        issues.push({
          kind: "missing",
          specPath,
          agent,
          cwd,
          scope,
          available: discovery.agents
            .map((item) => item.name)
            .sort((left, right) => left.localeCompare(right)),
        });
        return;
      case "ambiguous":
        issues.push({
          kind: "ambiguous",
          specPath,
          agent,
          cwd,
          scope,
          matches: resolvedAgent.matches
            .map((item) => item.name)
            .sort((left, right) => left.localeCompare(right)),
        });
        return;
    }
  };

  const visit = (
    spec: FlowSpec,
    specPath: string,
    cwd: string,
    scope: Scope,
  ) => {
    switch (spec.kind) {
      case "spawn":
        validateAgentReference(
          spec.agent,
          `${specPath}.agent`,
          spec.cwd ?? cwd,
          spec.scope ?? scope,
          (name) => {
            spec.agent = name;
          },
        );
        return;
      case "sequence":
        for (const [index, step] of spec.steps.entries()) {
          visit(step, sequenceStepPath(specPath, index), cwd, scope);
        }
        return;
      case "fork":
        for (const [branchKey, branchSpec] of Object.entries(spec.branches)) {
          visit(branchSpec, forkBranchPath(specPath, branchKey), cwd, scope);
        }
        return;
      case "join": {
        const reducer = spec.reducer;
        if (reducer?.kind === "agent") {
          validateAgentReference(
            reducer.agent,
            `${specPath}.reducer.agent`,
            cwd,
            scope,
            (name) => {
              reducer.agent = name;
            },
          );
        }
        return;
      }
      case "loop":
        visit(spec.body, loopBodyPath(specPath), cwd, scope);
        return;
    }
  };

  visit(flow, ROOT_FLOW_PATH, defaults.cwd, defaults.scope);

  if (issues.length > 0) {
    throw new Error(formatWorkflowAgentIssues(issues));
  }
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

const MAX_CONTEXT_PREVIEW_CHARS = 2_000;
const MAX_CONTEXT_NODES = 12;
const MAX_WORKFLOW_CONTEXT_CHARS = 12_000;

function previewContextValue(value: unknown): string {
  const summary = formatOutputSummary(value);
  if (summary.length <= MAX_CONTEXT_PREVIEW_CHARS) {
    return summary;
  }
  const remaining = summary.length - MAX_CONTEXT_PREVIEW_CHARS;
  return `${summary.slice(0, MAX_CONTEXT_PREVIEW_CHARS)}… (${remaining} more chars)`;
}

function summarizeForContext(result: FlowNodeResult): unknown {
  switch (result.kind) {
    case "spawn":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        agent: result.agent,
        output: previewContextValue(result.output),
      };
    case "sequence":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        steps: result.steps.length,
        output: previewContextValue(result.output),
      };
    case "fork":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        branches: Object.fromEntries(
          Object.entries(result.branches).map(([key, branch]) => [
            key,
            branch.result
              ? previewContextValue(branch.result.output)
              : { error: branch.error },
          ]),
        ),
        output: previewContextValue(result.output),
      };
    case "join":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        selectedBranches: result.selectedBranches,
        output: previewContextValue(result.output),
      };
    case "loop":
      return {
        kind: result.kind,
        nodeId: result.nodeId,
        iterations: result.iterations.length,
        output: previewContextValue(result.output),
      };
  }
}

function buildDelegatedTask(task: string, memory: FlowMemory): string {
  if (memory.history.length === 0) return task;
  const latest = memory.history[memory.history.length - 1];
  const nodeEntries = [...memory.bySpecId.entries()];
  const keptEntries = nodeEntries.slice(-MAX_CONTEXT_NODES);
  const truncatedNodes = nodeEntries.length - keptEntries.length;
  const payload = {
    latest: latest ? summarizeForContext(latest) : undefined,
    nodes: Object.fromEntries(
      keptEntries.map(([key, value]) => [key, summarizeForContext(value)]),
    ),
    ...(truncatedNodes > 0
      ? { truncatedNodes: `${truncatedNodes} earlier named node(s) omitted` }
      : {}),
  };

  let payloadText = JSON.stringify(payload, null, 2);
  if (payloadText.length > MAX_WORKFLOW_CONTEXT_CHARS) {
    payloadText = JSON.stringify(
      {
        latest: latest ? summarizeForContext(latest) : undefined,
        note: "Workflow context truncated to stay within the prompt budget.",
      },
      null,
      2,
    );
  }

  return [
    task,
    "",
    "Workflow context from prior completed steps:",
    "```json",
    payloadText,
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
): unknown {
  if (!spec) return undefined;
  // Try `output.<path>` first (e.g. bodyResult.output.done), then fall back
  // to `<path>` on the raw result itself. This lets callers write
  // `path: "done"` instead of the longer `path: "output.done"`.
  const output = (bodyResult as unknown as Record<string, unknown>).output;
  const fromOutput = getPathValue(output, spec.path);
  if (fromOutput !== undefined) return fromOutput;
  return getPathValue(bodyResult, spec.path);
}

function formatOutputSummary(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function summarizePreviewLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Workflow aborted.");
  }
}

export class RunExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  private emit(
    event: RunEvent,
    ctx: ExtensionContext,
    controls?: RunExecutionControls,
  ): void {
    applyRunEvent(this.options.runtimeState, event);
    if (controls?.appendEvent) controls.appendEvent(event);
    else appendRunEvent(this.options.pi, event);

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
            : AgentEvents.RUN_STOPPED,
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
      case "node_stopped":
        this.options.pi.events.emit(AgentEvents.AGENTS_STOPPED, {
          runId: event.runId,
          nodeId: event.nodeId,
          error: event.error,
        });
        break;
      default:
        break;
    }

    this.options.onStateChanged?.(ctx);
    controls?.onEvent?.(event);
  }

  private buildSnapshot(runId: string): RunResultDetails {
    const snapshot = getRunSnapshot(this.options.runtimeState, runId);
    if (!snapshot) {
      throw new Error(`Unknown flow ${runId}.`);
    }
    return snapshot;
  }

  async execute(
    params: WorkflowParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<RunResultDetails>) => void,
    defaults?: { model?: string; thinking?: Thinking },
    controls?: RunExecutionControls,
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
    const runCwd = params.cwd ?? ctx.cwd;
    const runScope = params.scope ?? "both";

    preflightWorkflowAgents(flow, {
      cwd: runCwd,
      scope: runScope,
    });

    const run: WorkflowRun = {
      id: runId,
      rootNodeId,
      label: params.label ?? flow.label ?? flow.kind,
      status: "running",
      startedAt: Date.now(),
      depth: 0,
      originSessionFile:
        typeof ctx.sessionManager?.getSessionFile === "function"
          ? ctx.sessionManager.getSessionFile()
          : undefined,
      flow,
      budgets: params.budgets,
      cwd: runCwd,
      scope: runScope,
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

    this.emit({ type: "run_created", at: run.startedAt, run }, ctx, controls);
    controls?.onRunCreated?.(runId);
    notifyUpdate();

    const initialState: EvaluationState = {
      runId,
      cwd: run.cwd,
      scope: run.scope,
      defaultModel: defaults?.model,
      defaultThinking: defaults?.thinking,
      depth: 1,
      budgets: new BudgetActor(params.budgets),
      memory: {
        bySpecId: new Map(),
        history: [],
      },
      signal,
      createNodeId,
      joinPlans: collectJoinPlans(flow),
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
        controls,
        rootNodeId,
        undefined,
        undefined,
        ROOT_FLOW_PATH,
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
        controls,
      );
      notifyUpdate();
      return this.buildSnapshot(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(
        {
          type: "run_completed",
          at: Date.now(),
          runId,
          status: "stopped",
          error: message,
        },
        ctx,
        controls,
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
    controls: RunExecutionControls | undefined,
    forcedNodeId?: string,
    branchKey?: string,
    iteration?: number,
    specPath = ROOT_FLOW_PATH,
  ): Promise<FlowNodeResult> {
    assertNotAborted(state.signal);

    const nodeId = forcedNodeId ?? state.createNodeId(spec);
    const node: RunNode = {
      id: nodeId,
      runId: state.runId,
      parentNodeId: state.parentNodeId,
      specId: spec.id,
      specPath,
      kind: spec.kind,
      label: spec.label,
      status: "running",
      branchKey,
      iteration,
      startedAt: Date.now(),
    };
    this.emit({ type: "node_started", at: Date.now(), node }, ctx, controls);
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
            notifyUpdate,
          );
          break;
        case "sequence":
          result = await this.evaluateSequence(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
            controls,
            specPath,
          );
          break;
        case "fork":
          result = await this.evaluateFork(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
            controls,
            specPath,
          );
          break;
        case "join":
          result = await this.evaluateJoin(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
            controls,
            specPath,
          );
          break;
        case "loop":
          result = await this.evaluateLoop(
            spec,
            nodeId,
            state,
            ctx,
            notifyUpdate,
            controls,
            specPath,
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
        controls,
      );
      notifyUpdate();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(
        {
          type: "node_stopped",
          at: Date.now(),
          runId: state.runId,
          nodeId,
          error: message,
        },
        ctx,
        controls,
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
    notifyUpdate?: () => void,
  ): Promise<SpawnNodeResult> {
    assertNotAborted(state.signal);
    await state.budgets.acquireSpawn(state.depth);
    assertNotAborted(state.signal);

    const scope = spec.scope ?? state.scope;
    const cwd = spec.cwd ?? state.cwd;
    const discovery = discoverAgents(cwd, scope);
    const diagnostics = toDiagnosticText(scope, discovery.diagnostics);
    const resolvedAgent = resolveAgentByName(discovery.agents, spec.agent);
    if (resolvedAgent.kind === "missing") {
      throw new Error(
        `Unknown agent "${spec.agent}" for scope=${scope}. Available: ${discovery.agents.map((item) => item.name).join(", ") || "none"}`,
      );
    }
    if (resolvedAgent.kind === "ambiguous") {
      throw new Error(
        `Agent name "${spec.agent}" is ambiguous ignoring case for scope=${scope}. Matches: ${resolvedAgent.matches.map((item) => item.name).join(", ")}`,
      );
    }
    const agent = resolvedAgent.agent;

    const task = buildDelegatedTask(spec.task, state.memory);
    const budgetLimits = await state.budgets.limits();
    assertNotAborted(state.signal);
    const handle = await state.handleRegistry.spawn(() =>
      this.options.manager.spawn({
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
        defaultModel: state.defaultModel,
        defaultThinking: state.defaultThinking,
      }),
    );
    const updateNodeProgress = (
      text: string,
      details: SpawnNodeResult["run"],
      status: SpawnNodeResult["run"]["status"],
      completedAt?: number,
    ) => {
      const node = this.options.runtimeState.nodes.get(nodeId);
      if (!node) return;
      const startedAt = node.startedAt ?? Date.now();
      const preview = summarizePreviewLine(text);
      node.progress = {
        text,
        preview,
        updatedAt: completedAt ?? Date.now(),
        details: {
          ...details,
          status,
          startedAt,
          completedAt,
          preview,
        },
      };
      this.options.onStateChanged?.(ctx);
      notifyUpdate?.();
    };
    const liveUpdates = (async () => {
      for await (const update of handle.updates) {
        updateNodeProgress(update.text, update.details, "running");
      }
    })().catch(() => undefined);

    const onAbort = () => {
      void handle.abort();
    };
    if (state.signal) {
      if (state.signal.aborted) onAbort();
      else state.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const spawnResult = await handle.wait();
      await liveUpdates;
      const completedAt = Date.now();
      updateNodeProgress(
        spawnResult.text,
        spawnResult.details,
        "completed",
        completedAt,
      );
      const output = resolveStructuredOutput(spec.output, spawnResult.text);
      const result: SpawnNodeResult = {
        nodeId,
        specId: spec.id,
        kind: "spawn",
        status: "completed",
        text: spawnResult.text,
        output,
        agent: agent.name,
        run: {
          ...spawnResult.details,
          status: "completed",
          startedAt: this.options.runtimeState.nodes.get(nodeId)?.startedAt,
          completedAt,
          preview: summarizePreviewLine(spawnResult.text),
        },
      };
      rememberResult(spec, result, state.memory);
      return result;
    } finally {
      await liveUpdates;
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
    controls: RunExecutionControls | undefined,
    specPath: string,
  ): Promise<SequenceNodeResult> {
    const steps: FlowNodeResult[] = [];
    const memory = cloneMemory(state.memory);
    let latestOutput: unknown;

    for (const [index, step] of spec.steps.entries()) {
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
        controls,
        undefined,
        undefined,
        undefined,
        sequenceStepPath(specPath, index),
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
    controls: RunExecutionControls | undefined,
    specPath: string,
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
      controls,
    );

    const entries = Object.entries(spec.branches) as Array<[string, FlowSpec]>;
    const concurrency = await state.budgets.getParallelismLimit(
      spec.concurrency,
    );
    const plan = state.joinPlans.get(spec.id);
    const failurePolicy = plan?.onFailure ?? "collectErrors";
    const coordinator = new ForkCoordinatorActor(entries, plan);
    const workerCount = Math.max(1, Math.min(concurrency, entries.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const entry = await coordinator.next();
          if (!entry) return;

          const [key, branchSpec] = entry;
          const { controller, dispose } = createLinkedAbortController(
            state.signal,
          );
          const registered = await coordinator.register(key, controller);
          if (!registered) {
            controller.abort();
            dispose();
            return;
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
              controls,
              undefined,
              key,
              undefined,
              forkBranchPath(specPath, key),
            );
            const controllers = await coordinator.recordSuccess(key, result);
            for (const sibling of controllers) {
              sibling.abort();
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (message.includes("aborted")) {
              const stopReason = await coordinator.stopReason();
              if (stopReason) {
                continue;
              }
              throw error;
            }

            const { controllers } = await coordinator.recordFailure(
              key,
              message,
            );
            for (const sibling of controllers) {
              sibling.abort();
            }
          } finally {
            dispose();
          }
        }
      }),
    );

    assertNotAborted(state.signal);

    const branchResults = await coordinator.outcomes();
    const primaryFailure = await coordinator.getPrimaryFailure();
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
    notifyUpdate: (() => void) | undefined,
    _controls: RunExecutionControls | undefined,
    _specPath: string,
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
        notifyUpdate,
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
    controls: RunExecutionControls | undefined,
    specPath: string,
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
        controls,
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
        controls,
        undefined,
        undefined,
        iteration,
        loopBodyPath(specPath),
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
        controls,
      );
      notifyUpdate();

      if (!spec.continueWhen) break;
      const continueValue = resolveContinueValue(spec.continueWhen, bodyResult);
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

  markBackgrounded(
    runId: string,
    ctx: ExtensionContext,
    controls?: RunExecutionControls,
  ): void {
    this.emit(
      {
        type: "run_backgrounded",
        at: Date.now(),
        runId,
      },
      ctx,
      controls,
    );
  }
}
