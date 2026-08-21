/** Cross-extension workflow control over pi's in-process event bus. */

import { statSync } from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type ListRpcData,
  type PingRpcData,
  PROTOCOL_VERSION,
  RPC_REPLY_PREFIX,
  RPC_REQUEST_CHANNEL,
  type RpcReply,
  type StartRpcData,
  type StopRpcData,
} from "../api.js";
import {
  discoverWorkflows,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import { effectiveScope, normalizeDisplayPath } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { isProjectTrusted } from "../run/persist.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_CALLER_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(
  value: unknown,
  name: string,
  maxLength?: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`'${name}' must be a non-empty string`);
  }
  const result = value.trim();
  if (maxLength !== undefined && result.length > maxLength) {
    throw new Error(`'${name}' must be at most ${maxLength} characters`);
  }
  return result;
}

function stringParams(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("'params' must be a string map");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`'params.${key}' must be a string`);
    }
    result[key] = item;
  }
  return result;
}

function resolveCwd(value: unknown, ctx: ExtensionContext): string {
  if (value === undefined) return ctx.cwd;
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("'cwd' must be an absolute path");
  }
  try {
    if (!statSync(value).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`'cwd' is not an existing directory: ${value}`);
  }
  return value;
}

export class RpcManager {
  private readonly pi: ExtensionAPI;
  private readonly deps: TriggerDeps;
  private readonly version: string;
  private context: ExtensionContext | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(pi: ExtensionAPI, deps: TriggerDeps, version: string) {
    this.pi = pi;
    this.deps = deps;
    this.version = version;
  }

  install(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pi.events.on(RPC_REQUEST_CHANNEL, (raw) => {
      void this.handle(raw);
    });
  }

  setContext(ctx: ExtensionContext | undefined): void {
    this.context = ctx;
  }

  dispose(): void {
    this.context = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(raw: unknown): Promise<void> {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !REQUEST_ID.test(raw.id)
    ) {
      return;
    }
    const id = raw.id;
    try {
      if (raw.protocol !== PROTOCOL_VERSION) {
        throw new Error(`unsupported protocol '${String(raw.protocol)}'`);
      }
      const caller = optionalString(raw.caller, "caller", MAX_CALLER_LENGTH);
      if (typeof raw.op !== "string") throw new Error("'op' must be a string");

      let data: PingRpcData | StartRpcData | StopRpcData | ListRpcData;
      switch (raw.op) {
        case "ping":
          if (raw.params !== undefined)
            throw new Error("'ping' does not accept params");
          data = { protocol: PROTOCOL_VERSION, version: this.version };
          break;
        case "start":
          data = this.start(raw.params, caller);
          break;
        case "stop":
          data = this.stop(raw.params);
          break;
        case "list":
          if (raw.params !== undefined)
            throw new Error("'list' does not accept params");
          data = this.list();
          break;
        default:
          throw new Error(`unknown RPC operation '${raw.op}'`);
      }
      this.reply(id, { protocol: PROTOCOL_VERSION, id, success: true, data });
    } catch (error) {
      this.reply(id, {
        protocol: PROTOCOL_VERSION,
        id,
        success: false,
        error: errorMessage(error),
      });
    }
  }

  private start(raw: unknown, caller: string | undefined): StartRpcData {
    const ctx = this.context;
    if (!ctx) throw new Error("No active session");
    if (!isRecord(raw)) throw new Error("'start' requires params");

    const hasFlow = raw.flow !== undefined;
    const workflow = optionalString(raw.workflow, "workflow");
    if (Number(hasFlow) + Number(workflow !== undefined) !== 1) {
      throw new Error("pass exactly one of 'flow' or 'workflow'");
    }
    const params = stringParams(raw.params);
    if (hasFlow && params !== undefined) {
      throw new Error("'params' is only valid with a saved workflow");
    }
    const label = optionalString(raw.label, "label");
    const requestedDisplay = normalizeDisplayPath(raw.display);
    const cwd = resolveCwd(raw.cwd, ctx);
    const trusted = isProjectTrusted(ctx);
    const scope = effectiveScope(undefined, trusted);
    const { workflows } = discoverWorkflows(cwd, scope);
    const resolveWorkflow = (name: string) =>
      resolveWorkflowByName(workflows, name);

    let input: unknown = raw.flow;
    let effectiveLabel = label;
    let display = requestedDisplay;
    if (workflow !== undefined) {
      const definition = resolveWorkflow(workflow);
      if (!definition) {
        const available =
          workflows.map((item) => item.name).join(", ") || "none";
        throw new Error(
          `unknown workflow '${workflow}'. Available: ${available}`,
        );
      }
      input = { kind: "workflow", name: definition.name, params: params ?? {} };
      effectiveLabel = effectiveLabel ?? definition.name;
      display = requestedDisplay ?? definition.display;
    }

    const flow = validateFlow(input, { resolveWorkflow });
    this.deps.notifications.setContext(ctx);
    const started = startTriggeredRun(this.deps, {
      flow,
      cwd,
      scope,
      label: effectiveLabel,
      display,
      source: { kind: "rpc", workflow, caller },
      ctx,
      background: true,
    });
    return { runId: started.runId };
  }

  private stop(raw: unknown): StopRpcData {
    if (!isRecord(raw) || typeof raw.runId !== "string" || !raw.runId) {
      throw new Error("'stop.runId' must be a non-empty string");
    }
    if (!this.deps.manager.stop(raw.runId)) {
      throw new Error(`run '${raw.runId}' is not live`);
    }
    return { runId: raw.runId };
  }

  private list(): ListRpcData {
    return {
      runs: [...this.deps.manager.state.order].reverse().flatMap((runId) => {
        const run = this.deps.manager.state.runs.get(runId);
        return run
          ? [
              {
                runId,
                label: run.header.label,
                status: run.status,
                source: { ...run.header.source },
              },
            ]
          : [];
      }),
    };
  }

  private reply(id: string, reply: RpcReply): void {
    try {
      this.pi.events.emit(`${RPC_REPLY_PREFIX}${id}`, reply);
    } catch {
      // The caller owns the reply listener; its failure must remain isolated.
    }
  }
}
