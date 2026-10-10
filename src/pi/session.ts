/**
 * SessionHost: owns the AgentService of the current Pi session. Storage lives
 * in `~/.pi/agent/pi-agents/sessions/<session-id>/`. A session that already
 * has agents opens at session start, so interrupted work resumes; otherwise
 * the service opens on first use. Ephemeral sessions (`--no-session`) cannot
 * resume, so their agents live in memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentService } from "../agents/service.js";
import { AgentError } from "../agents/types.js";
import { SkillCatalog } from "../catalog/skills.js";
import { createHarnessSettings } from "../host/env.js";
import {
  limitRequests,
  RequestLimiter,
  readRequestLimit,
} from "../host/limit.js";
import { acquireLock, type StorageLock } from "../host/lock.js";
import { resolveModels } from "../host/models.js";
import { createPromptExtension } from "../host/prompt.js";
import { openStorage, type Storage } from "../host/storage.js";
import { createToolsExtension } from "../host/tools.js";
import { resolveHelper } from "./spawn.js";

function sessionDirectory(sessionId: string): string {
  return path.join(getAgentDir(), "pi-agents", "sessions", sessionId);
}

function isPersistent(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getSessionFile() !== undefined;
}

function isTrusted(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : true;
}

export class SessionHost {
  private service: AgentService | undefined;
  private opening: Promise<AgentService> | undefined;
  private lock: StorageLock | undefined;
  private sessionId: string | undefined;
  private ctx: ExtensionContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private trusted = true;
  /** The skills agents can use, shared by spawns and agent prompts. */
  readonly skills = new SkillCatalog();
  /** Why agents are unavailable in this session, if they are. */
  unavailable: string | undefined;

  /** Session start: remember the context and resume existing agents. */
  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.trusted = isTrusted(ctx);
    this.unavailable = undefined;
    if (isPersistent(ctx) && fs.existsSync(sessionDirectory(this.sessionId))) {
      try {
        await this.ensure(ctx);
      } catch (error) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `pi-agents: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
      }
    }
  }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.trusted = isTrusted(ctx);
  }

  /** The open service, if any. */
  current(): AgentService | undefined {
    return this.service;
  }

  /** The service, opened on demand. */
  async ensure(ctx: ExtensionContext): Promise<AgentService> {
    this.setContext(ctx);
    if (this.service) return this.service;
    if (this.unavailable) throw new AgentError(this.unavailable);
    this.opening ??= this.open(ctx).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(ctx: ExtensionContext): Promise<AgentService> {
    const sessionId = this.sessionId ?? ctx.sessionManager.getSessionId();
    this.sessionId = sessionId;
    let lock: StorageLock | undefined;
    let storage: Storage;
    if (isPersistent(ctx)) {
      const directory = sessionDirectory(sessionId);
      const acquired = acquireLock(directory);
      if ("owner" in acquired) {
        this.unavailable = `Agents of this session belong to another Pi process (PID ${acquired.owner}).`;
        throw new AgentError(this.unavailable);
      }
      lock = acquired;
      try {
        storage = await openStorage(directory);
      } catch (error) {
        lock.release();
        throw error;
      }
    } else {
      storage = await openStorage(undefined);
    }
    try {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir());
      const { limit, error } = readRequestLimit(settings.getSettings());
      if (error) this.report(new Error(`${error}; requests aren't limited`));
      const models = limitRequests(
        await resolveModels(ctx.modelRegistry),
        new RequestLimiter(limit),
      );
      const service = await AgentService.open({
        storage,
        models,
        cwd: ctx.cwd,
        settings: createHarnessSettings(settings),
        extensions: [
          createToolsExtension(),
          createPromptExtension({
            trusted: () => this.trusted,
            skills: this.skills.get,
          }),
        ],
        onReport: (error) => this.report(error),
        resolveHelper: (request, defaults) => {
          const current = this.ctx;
          if (!current) throw new AgentError("Pi isn't ready for helpers yet");
          return resolveHelper(request, current, defaults, this.skills.get);
        },
      });
      this.service = service;
      this.lock = lock;
      this.unsubscribe = service.subscribe(() => this.emit());
      this.emit();
      return service;
    } catch (error) {
      lock?.release();
      throw error;
    }
  }

  private report(error: unknown): void {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return;
    ctx.ui.notify(
      `pi-agents: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Session shutdown: pause agents and release the storage. */
  async stop(): Promise<void> {
    const opening = this.opening;
    if (opening) await opening.catch(() => {});
    const service = this.service;
    this.service = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      await service?.close();
    } finally {
      this.lock?.release();
      this.lock = undefined;
      this.emit();
    }
  }
}
