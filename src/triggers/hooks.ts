/**
 * Event hooks: workflows that declare `on: [pi-event-names]` fire when those
 * events occur. Hook runs always start in the background and deliver their
 * result as an idle notification.
 *
 * Guards:
 * - A re-entrancy flag suppresses events emitted while a hook run is being
 *   started (no synchronous cascades), and hook runs execute as subprocesses,
 *   so they never emit in-session events themselves.
 * - Per-workflow trailing-edge debounce coalesces bursts.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  discoverWorkflows,
  HOOKABLE_EVENTS,
  resolveWorkflowByName,
} from "../catalog/workflows.js";
import type { WorkflowDef } from "../model/ast.js";
import { validateFlow } from "../model/validate.js";
import { isProjectTrusted } from "../run/persist.js";
import { sendInfo } from "../ui/render.js";
import { startTriggeredRun, type TriggerDeps } from "./start.js";

const MAX_EVENT_JSON_CHARS = 4000;
const DROPPED_EVENT_KEYS = new Set([
  "systemPrompt",
  "systemPromptOptions",
  "messages",
]);

/** Compact, size-capped JSON of the triggering event for {params.event}. */
export function compactEventJson(event: unknown): string {
  let json: string;
  try {
    json =
      JSON.stringify(event, (key, value) => {
        if (DROPPED_EVENT_KEYS.has(key)) return undefined;
        if (typeof value === "string" && value.length > 500) {
          return `${value.slice(0, 500)}…`;
        }
        return value;
      }) ?? "{}";
  } catch {
    json = "{}";
  }
  if (json.length > MAX_EVENT_JSON_CHARS) {
    json = `${json.slice(0, MAX_EVENT_JSON_CHARS)}…`;
  }
  return json;
}

/** Escape braces so the event JSON binds as a literal param value. */
function escapeBraces(value: string): string {
  return value.replaceAll("{", "{{").replaceAll("}", "}}");
}

export class HookManager {
  private readonly pi: ExtensionAPI;
  private readonly deps: TriggerDeps;
  /** Events any discovered workflow currently hooks; cheap pre-filter. */
  private hookedEvents = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private firing = false;
  private disposed = false;

  constructor(pi: ExtensionAPI, deps: TriggerDeps) {
    this.pi = pi;
    this.deps = deps;
  }

  /** Subscribe to every hookable event once, at factory time. */
  install(): void {
    for (const name of HOOKABLE_EVENTS) {
      // The union overloads of pi.on don't matter here: we treat the event
      // as an opaque payload.
      (this.pi.on as (event: string, handler: unknown) => void)(
        name,
        (event: unknown, ctx: ExtensionContext) =>
          this.handle(name, event, ctx),
      );
    }
  }

  /** Re-scan saved workflows for hooked events (session_start / reload). */
  refresh(cwd: string, trusted = true): void {
    const { workflows } = discoverWorkflows(cwd, trusted ? "both" : "user");
    this.hookedEvents = new Set(workflows.flatMap((wf) => wf.on ?? []));
  }

  private handle(
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ): void {
    if (this.disposed || this.firing) return;
    // Untrusted projects contribute no hook workflows: repository content
    // must never auto-execute agents without the user's trust decision.
    const trusted = isProjectTrusted(ctx);
    // session_start is also our discovery point; refresh before filtering so
    // `on: [session_start]` workflows see their own trigger.
    if (eventName === "session_start") this.refresh(ctx.cwd, trusted);
    if (!this.hookedEvents.has(eventName)) return;
    const { workflows } = discoverWorkflows(ctx.cwd, trusted ? "both" : "user");
    for (const wf of workflows) {
      if (!wf.on?.includes(eventName)) continue;
      this.schedule(wf, eventName, event, ctx);
    }
  }

  private schedule(
    wf: WorkflowDef,
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ): void {
    const existing = this.timers.get(wf.name);
    if (existing) clearTimeout(existing);
    const fire = () => {
      this.timers.delete(wf.name);
      this.fire(wf.name, eventName, event, ctx);
    };
    const delay = wf.debounce ?? 0;
    if (delay <= 0) {
      fire();
      return;
    }
    const timer = setTimeout(fire, delay);
    timer.unref?.();
    this.timers.set(wf.name, timer);
  }

  private fire(
    name: string,
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ): void {
    if (this.disposed) return;
    this.firing = true;
    try {
      // Re-resolve so file edits between trigger and fire apply; trust may
      // also have changed between debounce scheduling and firing.
      const { workflows } = discoverWorkflows(
        ctx.cwd,
        isProjectTrusted(ctx) ? "both" : "user",
      );
      const wf = resolveWorkflowByName(workflows, name);
      if (!wf?.on?.includes(eventName)) return;
      const flow = validateFlow(
        {
          kind: "workflow",
          name: wf.name,
          params: {
            event: escapeBraces(
              compactEventJson({ type: eventName, ...(event as object) }),
            ),
          },
        },
        {
          resolveWorkflow: (candidate) =>
            resolveWorkflowByName(workflows, candidate),
        },
      );
      this.deps.notifications.setContext(ctx);
      const started = startTriggeredRun(this.deps, {
        flow,
        cwd: ctx.cwd,
        scope: "both",
        label: `${wf.name} (on ${eventName})`,
        display: wf.display,
        source: { kind: "hook", workflow: wf.name, event: eventName },
        ctx,
        background: true,
      });
      void started;
    } catch (error) {
      sendInfo(
        this.pi,
        `⚠ hook workflow \`${name}\` failed to start on \`${eventName}\`: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.firing = false;
    }
  }

  /** For tests and diagnostics. */
  pendingDebounces(): string[] {
    return [...this.timers.keys()];
  }

  /** Stop firing and clear pending debounce timers (session_shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
