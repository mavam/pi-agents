/**
 * Public, import-optional event-bus contract for pi-agents.
 *
 * Co-loaded extensions may either import these types and helpers from
 * `pi-agents/api` or use the documented channel strings directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowNode } from "./model/ast.js";
import type { RunEvent, RunSource, RunStatus } from "./run/events.js";

export const PROTOCOL_VERSION = 1 as const;
export const RUN_EVENT_CHANNEL = "pi-agents:run-event";
export const READY_CHANNEL = "pi-agents:ready";
export const RPC_REQUEST_CHANNEL = "pi-agents:rpc:request";
export const RPC_REPLY_PREFIX = "pi-agents:rpc:reply:";

export interface RunEventEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  event: RunEvent;
}

export interface ReadyEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  version: string;
}

export interface StartRpcParams {
  /** Inline flow expression. Exactly one of flow and workflow is required. */
  flow?: FlowNode;
  /** Saved workflow name. Exactly one of flow and workflow is required. */
  workflow?: string;
  /** Literal parameters for a saved workflow. */
  params?: Record<string, string>;
  label?: string;
  /** Absolute path to an existing working directory. */
  cwd?: string;
}

export interface StopRpcParams {
  runId: string;
}

interface RpcRequestBase {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  /** Self-declared extension name, used only for attribution. */
  caller?: string;
}

export type RpcRequest =
  | (RpcRequestBase & { op: "ping"; params?: never })
  | (RpcRequestBase & { op: "start"; params: StartRpcParams })
  | (RpcRequestBase & { op: "stop"; params: StopRpcParams })
  | (RpcRequestBase & { op: "list"; params?: never });

export type RpcReply<T = unknown> =
  | {
      protocol: typeof PROTOCOL_VERSION;
      id: string;
      success: true;
      data: T;
    }
  | {
      protocol: typeof PROTOCOL_VERSION;
      id: string;
      success: false;
      error: string;
    };

export interface PingRpcData {
  protocol: typeof PROTOCOL_VERSION;
  version: string;
}

export interface StartRpcData {
  runId: string;
}

export interface StopRpcData {
  runId: string;
}

export interface RunSummary {
  runId: string;
  label?: string;
  status: RunStatus;
  source: RunSource;
}

export interface ListRpcData {
  runs: RunSummary[];
}

export interface PiAgentsClientOptions {
  caller?: string;
  /** RPC reply timeout. Defaults to 5 seconds. */
  timeoutMs?: number;
}

export interface PiAgentsClient {
  ping(): Promise<PingRpcData>;
  start(params: StartRpcParams): Promise<StartRpcData>;
  stop(runId: string): Promise<StopRpcData>;
  list(): Promise<ListRpcData>;
  onRunEvent(handler: (event: RunEvent) => void): () => void;
  onReady(handler: (ready: ReadyEnvelope) => void): () => void;
}

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function rpcRequest<T>(
  pi: ExtensionAPI,
  op: RpcRequest["op"],
  params: unknown,
  options: PiAgentsClientOptions,
): Promise<T> {
  const id = crypto.randomUUID();
  const replyChannel = `${RPC_REPLY_PREFIX}${id}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("RPC timeout must be a positive number"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      fn();
    };

    unsubscribe = pi.events.on(replyChannel, (raw) => {
      if (!isRecord(raw) || raw.id !== id) return;
      if (
        raw.protocol !== PROTOCOL_VERSION ||
        typeof raw.success !== "boolean"
      ) {
        finish(() => reject(new Error("Invalid pi-agents RPC reply")));
        return;
      }
      if (raw.success) {
        finish(() => resolve(raw.data as T));
        return;
      }
      finish(() =>
        reject(
          new Error(
            typeof raw.error === "string"
              ? raw.error
              : "Unknown pi-agents RPC error",
          ),
        ),
      );
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error(`pi-agents RPC '${op}' timed out`)));
    }, timeoutMs);
    timer.unref?.();

    const request: Record<string, unknown> = {
      protocol: PROTOCOL_VERSION,
      id,
      op,
    };
    if (options.caller !== undefined) request.caller = options.caller;
    if (params !== undefined) request.params = params;
    try {
      pi.events.emit(RPC_REQUEST_CHANNEL, request);
    } catch (error) {
      finish(() => reject(new Error(errorMessage(error))));
    }
  });
}

/** Create a typed client over the same import-free event-bus protocol. */
export function createPiAgentsClient(
  pi: ExtensionAPI,
  options: PiAgentsClientOptions = {},
): PiAgentsClient {
  return {
    ping: () => rpcRequest(pi, "ping", undefined, options),
    start: (params) => rpcRequest(pi, "start", params, options),
    stop: (runId) => rpcRequest(pi, "stop", { runId }, options),
    list: () => rpcRequest(pi, "list", undefined, options),
    onRunEvent: (handler) =>
      pi.events.on(RUN_EVENT_CHANNEL, (raw) => {
        if (
          !isRecord(raw) ||
          raw.protocol !== PROTOCOL_VERSION ||
          !isRecord(raw.event) ||
          typeof raw.event.type !== "string"
        )
          return;
        handler(raw.event as unknown as RunEvent);
      }),
    onReady: (handler) =>
      pi.events.on(READY_CHANNEL, (raw) => {
        if (
          !isRecord(raw) ||
          raw.protocol !== PROTOCOL_VERSION ||
          typeof raw.version !== "string"
        )
          return;
        handler(raw as unknown as ReadyEnvelope);
      }),
  };
}

export type { FlowNode, RunEvent, RunSource, RunStatus };
