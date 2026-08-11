import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePath } from "../model/interpolate.js";
import type { RunStatus } from "../run/events.js";
import { getSessionFile } from "../run/persist.js";
import type { RunManager } from "../run/runs.js";
import { MAX_STEERING_MESSAGE_CHARS } from "../run/runs.js";
import { type RunView, workNodes } from "../run/state.js";
import {
  formatRunSource,
  nodeDisplayName,
  selectDisplayValue,
  shortId,
} from "../ui/render.js";
import { renderRunTree } from "../ui/tree.js";
import type { TriggerDeps } from "./start.js";

const RUN_ID_DESCRIPTION = "Full workflow run ID or unique ID prefix.";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_INSPECT_LIMIT = 20;
const MAX_INSPECT_LIMIT = 25;
const DEFAULT_RESULT_LIMIT = 16_000;
const MAX_RESULT_LIMIT = 50_000;
const RESULT_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function isRunInSession(
  run: RunView,
  sessionFile: string | undefined,
): boolean {
  const origin = run.header.originSessionFile;
  return origin === undefined || origin === sessionFile;
}

function resolveRun(
  manager: RunManager,
  ref: string,
  ctx: ExtensionContext,
): RunView {
  const sessionFile = getSessionFile(ctx);
  const exact = manager.state.runs.get(ref);
  if (exact && isRunInSession(exact, sessionFile)) return exact;
  const matches = [...manager.state.runs.values()].filter(
    (run) => isRunInSession(run, sessionFile) && run.header.id.startsWith(ref),
  );
  if (matches.length === 0) {
    throw new Error(`No run matching '${ref}'.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous run id '${ref}': ${matches
        .map((run) => shortId(run.header.id))
        .join(", ")}`,
    );
  }
  return matches[0] as RunView;
}

function compactText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  if (!value) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function serialized(value: unknown, raw: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (!raw && typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

const WorkflowListParams = Type.Object({
  status: Type.Optional(
    StringEnum(["running", "completed", "failed", "stopped"] as const, {
      description: "Optional run-status filter.",
    }),
  ),
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Run offset for paginated listing. Defaults to 0.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      description: `Maximum runs to return. Defaults to ${DEFAULT_LIST_LIMIT}.`,
    }),
  ),
});

interface WorkflowListDetails {
  total: number;
  cursor: number;
  nextCursor?: number;
  runs: Array<{
    runId: string;
    id: string;
    status: RunStatus;
    live: boolean;
    label?: string;
    source: string;
    startedAt: string;
    endedAt?: string;
    agents?: number;
  }>;
}

/** List persisted runs in the current session. */
export function createWorkflowListTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowListParams, WorkflowListDetails> {
  return {
    name: "workflow_list",
    label: "Workflow List",
    description:
      "List recent workflow runs persisted in the current session. Optionally filter by status. Results are paginated and nextCursor indicates another page. Use workflow_inspect with a returned run ID for its tree and live state.",
    promptSnippet: "List recent workflow runs from the current session",
    parameters: WorkflowListParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const sessionFile = getSessionFile(ctx);
      const matching = [...deps.manager.state.order]
        .reverse()
        .flatMap((runId) => {
          const run = deps.manager.state.runs.get(runId);
          return run &&
            isRunInSession(run, sessionFile) &&
            (!params.status || run.status === params.status)
            ? [run]
            : [];
        });
      const cursor = params.cursor ?? 0;
      if (cursor > matching.length) {
        throw new Error(
          `Cursor ${cursor} exceeds the ${matching.length} matching runs.`,
        );
      }
      const end = Math.min(
        matching.length,
        cursor + (params.limit ?? DEFAULT_LIST_LIMIT),
      );
      const runs = matching.slice(cursor, end).map((run) => ({
        runId: run.header.id,
        id: shortId(run.header.id),
        status: run.status,
        live: deps.manager.isLive(run.header.id),
        label: run.header.label,
        source: formatRunSource(run.header.source),
        startedAt: new Date(run.createdAt).toISOString(),
        endedAt:
          run.endedAt === undefined
            ? undefined
            : new Date(run.endedAt).toISOString(),
        agents: run.agents,
      }));
      const details: WorkflowListDetails = {
        total: matching.length,
        cursor,
        nextCursor: end < matching.length ? end : undefined,
        runs,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

const WorkflowInspectParams = Type.Object({
  run: Type.String({ description: RUN_ID_DESCRIPTION }),
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Node offset for paginated inspection. Defaults to 0.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_INSPECT_LIMIT,
      description: `Maximum nodes to return. Defaults to ${DEFAULT_INSPECT_LIMIT}; maximum ${MAX_INSPECT_LIMIT}.`,
    }),
  ),
});

interface WorkflowInspectDetails {
  runId: string;
  id: string;
  status: RunStatus;
  live: boolean;
  label?: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  agents?: number;
  usage?: RunView["usage"];
  tree: string;
  cursor: number;
  totalNodes: number;
  nextCursor?: number;
  nodes: Array<{
    instance: string;
    name: string;
    agent?: string;
    kind: string;
    status: string;
    steerable: boolean;
    startedAt: string;
    endedAt?: string;
    error?: string;
    cancelReason?: string;
    progressSummary?: string;
    progressTool?: string;
    progressText?: string;
    hasResult: boolean;
    hasPartialResult: boolean;
    steeringCount: number;
  }>;
}

/** Inspect one run without returning its potentially large result values. */
export function createWorkflowInspectTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowInspectParams, WorkflowInspectDetails> {
  return {
    name: "workflow_inspect",
    label: "Workflow Inspect",
    description:
      "Inspect one existing workflow run: status, live tree, usage, errors, node instances, progress, and steering availability. Nodes are paginated and nextCursor indicates another page. This does not return completed result values; use workflow_result for those.",
    promptSnippet:
      "Inspect the status and node tree of an existing workflow run",
    parameters: WorkflowInspectParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const run = resolveRun(deps.manager, params.run, ctx);
      const steerable = new Set(deps.manager.steerableInstances(run.header.id));
      const nodes = workNodes(run);
      const cursor = params.cursor ?? 0;
      if (cursor > nodes.length) {
        throw new Error(
          `Cursor ${cursor} exceeds the run's ${nodes.length} nodes.`,
        );
      }
      const end = Math.min(
        nodes.length,
        cursor + (params.limit ?? DEFAULT_INSPECT_LIMIT),
      );
      const details: WorkflowInspectDetails = {
        runId: run.header.id,
        id: shortId(run.header.id),
        status: run.status,
        live: deps.manager.isLive(run.header.id),
        label: run.header.label,
        source: formatRunSource(run.header.source),
        startedAt: new Date(run.createdAt).toISOString(),
        endedAt:
          run.endedAt === undefined
            ? undefined
            : new Date(run.endedAt).toISOString(),
        error: run.error,
        agents: run.agents,
        usage: run.usage,
        tree: compactText(renderRunTree(run) || "(no nodes yet)", 10_000) ?? "",
        cursor,
        totalNodes: nodes.length,
        nextCursor: end < nodes.length ? end : undefined,
        nodes: nodes.slice(cursor, end).map((node) => ({
          instance: node.instance,
          name: nodeDisplayName(node),
          agent: node.agent,
          kind: node.kind,
          status: node.status,
          steerable: steerable.has(node.instance),
          startedAt: new Date(node.startedAt).toISOString(),
          endedAt:
            node.endedAt === undefined
              ? undefined
              : new Date(node.endedAt).toISOString(),
          error: node.error,
          cancelReason: node.cancelReason,
          progressSummary: compactText(node.progressSummary, 500),
          progressTool: node.progressTool,
          progressText: compactText(node.progressText, 1_000),
          hasResult: node.value !== undefined,
          hasPartialResult:
            node.partialText !== undefined ||
            (node.status === "failed" && node.progressText !== undefined),
          steeringCount: node.steering.length,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

const WorkflowResultParams = Type.Object({
  run: Type.String({ description: RUN_ID_DESCRIPTION }),
  instance: Type.Optional(
    Type.String({
      description:
        "Exact node instance returned by workflow_inspect. Omit for the run's final result.",
    }),
  ),
  view: Type.Optional(
    StringEnum(["presented", "raw"] as const, {
      description:
        "Use the run's display selection or serialize the underlying value. Defaults to presented.",
      default: "presented",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Dot path to select within the underlying structured value before rendering. Numeric segments index arrays.",
    }),
  ),
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Character offset for paginated retrieval. Defaults to 0.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RESULT_LIMIT,
      description: `Maximum characters to return. Defaults to ${DEFAULT_RESULT_LIMIT}; maximum ${MAX_RESULT_LIMIT}.`,
    }),
  ),
});

interface WorkflowResultDetails {
  runId: string;
  id: string;
  instance?: string;
  status: string;
  view: "presented" | "raw";
  path?: string;
  cursor: number;
  totalChars: number;
  nextCursor?: number;
  truncated: boolean;
  partial: boolean;
  warning?: string;
}

/** Retrieve a final run value or one node's result with bounded pagination. */
export function createWorkflowResultTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowResultParams, WorkflowResultDetails> {
  return {
    name: "workflow_result",
    label: "Workflow Result",
    description: `Retrieve a persisted workflow run result or one node result. Results are paginated by character offset; calls default to ${DEFAULT_RESULT_LIMIT} characters, accept up to ${MAX_RESULT_LIMIT}, and report nextCursor when more remain. Use path to select part of a structured value and view raw to preserve its JSON representation.`,
    promptSnippet:
      "Retrieve a workflow run or node result, with path selection and pagination",
    promptGuidelines: [
      "When workflow_result reports nextCursor, call workflow_result again with that cursor only when the omitted content is needed for the task.",
    ],
    parameters: WorkflowResultParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const run = resolveRun(deps.manager, params.run, ctx);
      const node = params.instance ? run.nodes.get(params.instance) : undefined;
      if (params.instance && !node) {
        throw new Error(
          `No node instance '${params.instance}' in run ${shortId(run.header.id)}. Use workflow_inspect to list exact instances.`,
        );
      }

      const status = node?.status ?? run.status;
      let value = node ? node.value : run.value;
      let partial = false;
      if (node && value === undefined && node.status === "failed") {
        const preserved = node.partialText ?? node.progressText;
        if (preserved !== undefined) {
          value = preserved;
          partial = true;
        }
      }
      if (status === "running" && value === undefined) {
        throw new Error(
          `${node ? `Node '${node.instance}'` : `Run ${shortId(run.header.id)}`} is still running. Use workflow_inspect for live progress.`,
        );
      }
      if (value === undefined) {
        throw new Error(
          `${node ? `Node '${node.instance}'` : `Run ${shortId(run.header.id)}`} has no result value${(node?.error ?? run.error) ? `: ${node?.error ?? run.error}` : "."}`,
        );
      }

      const path = params.path?.trim();
      if (path !== undefined && !RESULT_PATH_RE.test(path)) {
        throw new Error("Invalid 'path' (must be a non-empty dot path)");
      }
      if (path) {
        const resolved = resolvePath(value, path.split("."));
        if (!resolved.found) {
          throw new Error(`Result path '${path}' was not found.`);
        }
        value = resolved.value;
      }

      const view = params.view ?? "presented";
      let warning: string | undefined;
      if (!node && !path && view === "presented") {
        const display = selectDisplayValue(value, run.header.display);
        value = display.value;
        warning = display.warning;
      }
      const text = serialized(value, view === "raw");
      if (text === undefined) {
        throw new Error("The selected result has no serializable value.");
      }

      const cursor = params.cursor ?? 0;
      if (cursor > text.length) {
        throw new Error(
          `Cursor ${cursor} exceeds the result length of ${text.length} characters.`,
        );
      }
      const limit = params.limit ?? DEFAULT_RESULT_LIMIT;
      const end = Math.min(text.length, cursor + limit);
      const nextCursor = end < text.length ? end : undefined;
      const details: WorkflowResultDetails = {
        runId: run.header.id,
        id: shortId(run.header.id),
        instance: node?.instance,
        status,
        view,
        path,
        cursor,
        totalChars: text.length,
        nextCursor,
        truncated: nextCursor !== undefined,
        partial,
        warning,
      };
      const attributes = [
        `run="${shortId(run.header.id)}"`,
        node ? `instance="${node.instance}"` : undefined,
        `status="${status}"`,
        `view="${view}"`,
        path ? `path="${path}"` : undefined,
        `cursor="${cursor}"`,
        `totalChars="${text.length}"`,
        nextCursor === undefined ? undefined : `nextCursor="${nextCursor}"`,
        partial ? 'partial="true"' : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      const lines = [`<workflow-result ${attributes}>`];
      if (warning) lines.push(`<warning>${warning}</warning>`);
      lines.push("<value>", text.slice(cursor, end), "</value>");
      if (nextCursor !== undefined) {
        const continuation = {
          run: run.header.id,
          instance: node?.instance,
          view,
          path,
          cursor: nextCursor,
          limit,
        };
        lines.push(
          `<more>Continue with workflow_result(${JSON.stringify(continuation)}).</more>`,
        );
      }
      lines.push("</workflow-result>");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details,
      };
    },
  };
}

const WorkflowSteerParams = Type.Object({
  run: Type.String({ description: RUN_ID_DESCRIPTION }),
  instance: Type.Optional(
    Type.String({
      description:
        "Exact live node instance returned by workflow_inspect. Omit only when one agent is steerable.",
    }),
  ),
  message: Type.String({
    minLength: 1,
    maxLength: MAX_STEERING_MESSAGE_CHARS,
    description: `Course correction to queue (maximum ${MAX_STEERING_MESSAGE_CHARS} characters).`,
  }),
});

interface WorkflowSteerDetails {
  runId: string;
  instance: string;
}

/** Model-facing control for a live background agent. */
export function createWorkflowSteerTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowSteerParams, WorkflowSteerDetails> {
  return {
    name: "workflow_steer",
    label: "Workflow Steer",
    description:
      "Queue a course correction for one agent in a live workflow run. The message is delivered after the agent's current assistant turn finishes its tool calls. Use workflow_inspect to discover exact steerable instances.",
    promptSnippet: "Steer one agent in a live workflow run",
    promptGuidelines: [
      "Use workflow_steer only for an existing live run; it never starts, restarts, or resumes an agent.",
      "Omit workflow_steer's instance only when exactly one agent in the run is currently steerable.",
    ],
    parameters: WorkflowSteerParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const run = resolveRun(deps.manager, params.run, ctx);
      const runId = run.header.id;
      const available = deps.manager.steerableInstances(runId);
      const instance =
        params.instance ?? (available.length === 1 ? available[0] : undefined);
      if (!instance || !available.includes(instance)) {
        const choices = available.length > 0 ? available.join(", ") : "none";
        throw new Error(
          params.instance
            ? `Instance '${params.instance}' is not steerable. Available: ${choices}`
            : `Run ${shortId(runId)} has ${available.length} steerable instances. Specify one of: ${choices}`,
        );
      }
      const result = await deps.manager.steer(
        runId,
        instance,
        params.message,
        "tool",
      );
      if (result.status !== "queued") {
        throw new Error(
          result.status === "rejected"
            ? result.error
            : result.reason === "run_not_live"
              ? `Run ${shortId(runId)} is not live.`
              : `Instance '${instance}' is no longer steerable.`,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Steering queued for ${instance} in run ${shortId(runId)}. It will be delivered after the current assistant turn finishes its tool calls.`,
          },
        ],
        details: { runId, instance },
      };
    },
  };
}

const WorkflowStopParams = Type.Object({
  run: Type.String({ description: RUN_ID_DESCRIPTION }),
});

interface WorkflowStopDetails {
  runId: string;
  status: RunStatus;
  outcome: "stopping" | "already_settled";
}

/** Stop one live run after an explicit user request. */
export function createWorkflowStopTool(
  deps: TriggerDeps,
): ToolDefinition<typeof WorkflowStopParams, WorkflowStopDetails> {
  return {
    name: "workflow_stop",
    label: "Workflow Stop",
    description:
      "Stop a live workflow run. Use this destructive operation only when the user explicitly asks to stop or cancel that run. A run that settled before the call is reported without error.",
    promptSnippet:
      "Stop a workflow run only when the user explicitly requests cancellation",
    promptGuidelines: [
      "Call workflow_stop only when the user explicitly asks to stop or cancel the run; never terminate a run merely because it appears slow, unnecessary, or likely to fail.",
    ],
    parameters: WorkflowStopParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const run = resolveRun(deps.manager, params.run, ctx);
      if (!deps.manager.isLive(run.header.id)) {
        const details: WorkflowStopDetails = {
          runId: run.header.id,
          status: run.status,
          outcome: "already_settled",
        };
        return {
          content: [
            {
              type: "text",
              text: `Run ${shortId(run.header.id)} already settled with status ${run.status}; nothing was stopped.`,
            },
          ],
          details,
        };
      }
      deps.manager.stop(run.header.id);
      const details: WorkflowStopDetails = {
        runId: run.header.id,
        status: run.status,
        outcome: "stopping",
      };
      return {
        content: [
          {
            type: "text",
            text: `Stopping workflow run ${shortId(run.header.id)}.`,
          },
        ],
        details,
      };
    },
  };
}
