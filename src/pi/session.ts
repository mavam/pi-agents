/**
 * SessionHost: hosts the agents of the current Pi session. It owns the
 * storage, its lock, and the harness, and hands the harness, its anchor,
 * and the parent, Pi's session, to the AgentService. Storage lives in
 * `~/.pi/agent/pi-agents/sessions/<session-id>/`. A session that already
 * has agents opens at session start, so interrupted work resumes; otherwise
 * the service opens on first use. Ephemeral sessions (`--no-session`) cannot
 * resume, so their agents live in memory.
 *
 * A storage error closes the harness. The host then pauses the agents,
 * says so, and reopens the harness, which resumes their work; a second
 * failure within a minute leaves them paused until the next use. Memory
 * storage can't reopen, so an ephemeral session's agents are lost.
 *
 * Opening, closing, and recovering are ordered: closing releases the lock
 * it took over, opening waits until earlier closes are done, and a
 * shutdown or session start ends the epoch a recovery belongs to, so the
 * recovery stops instead of reopening.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAgentExtensions } from "../agents/extensions.js";
import type { Parent } from "../agents/parent.js";
import { AgentService } from "../agents/service.js";
import { AgentError } from "../agents/types.js";
import { SkillCatalog } from "../catalog/skills.js";
import { type AgentHarness, openAgentHarness } from "../host/harness.js";
import { createHarnessSettings } from "../host/harness-setup.js";
import { acquireLock, type StorageLock } from "../host/lock.js";
import { resolveModels } from "../host/models.js";
import { pruneSessions, readRetention } from "../host/retention.js";
import { openStorage, type Storage } from "../host/storage.js";
import { readWorkingLimit } from "../host/working.js";
import { notify } from "./notify.js";
import { isTrusted, resolveHelper } from "./spawn.js";

function sessionsRoot(): string {
  return path.join(getAgentDir(), "pi-agents", "sessions");
}

function sessionDirectory(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId);
}

/** How soon after a storage failure the host reopens again by itself. */
const REOPEN_INTERVAL_MS = 60_000;

export interface SessionHostOptions {
  /** Tests only: open the storage of a directory, or memory without one. */
  openStorage?: (directory: string | undefined) => Promise<Storage>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPersistent(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getSessionFile() !== undefined;
}

export class SessionHost {
  private service: AgentService | undefined;
  private harness: AgentHarness | undefined;
  private opening: Promise<AgentService> | undefined;
  private lock: StorageLock | undefined;
  private sessionId: string | undefined;
  private ctx: ExtensionContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private trusted = true;
  private pruned = false;
  /** Whether the open storage persists, so a failure can reopen it. */
  private persistent = false;
  /** Bumped by session start and shutdown, which end recoveries. */
  private epoch = 0;
  /** Closes in progress, in order; opening waits for them. */
  private closing: Promise<void> = Promise.resolve();
  /** The recovery from a storage failure, while it runs. */
  private recovering: Promise<void> | undefined;
  /** When this session's storage last failed, to reopen by itself at most
   * once a minute. */
  private failedAt: number | undefined;
  /** The skills agents can use, shared by spawns and agent prompts. */
  readonly skills = new SkillCatalog();
  /** Why agents are unavailable in this session, if they are. */
  unavailable: string | undefined;

  constructor(
    private readonly parent: Parent,
    private readonly options: SessionHostOptions = {},
  ) {}

  /** Session start: remember the context and resume existing agents. */
  async start(ctx: ExtensionContext): Promise<void> {
    this.epoch++;
    this.failedAt = undefined;
    this.ctx = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.trusted = isTrusted(ctx);
    this.unavailable = undefined;
    if (isPersistent(ctx) && fs.existsSync(sessionDirectory(this.sessionId))) {
      try {
        await this.ensure(ctx);
      } catch (error) {
        notify(ctx, `pi-agents: ${message(error)}`);
      }
    }
    this.prune(ctx);
  }

  /**
   * Once per host, delete the storage of sessions older than
   * `piAgents.retentionDays`, in the background. Pi starts a new host for
   * every session it replaces.
   */
  private prune(ctx: ExtensionContext): void {
    if (this.pruned) return;
    const current = this.sessionId;
    const epoch = this.epoch;
    // Pi invalidates the context when it replaces the session.
    const cwd = ctx.cwd;
    void (async () => {
      // Off the startup path: settings and storage are read afterwards.
      await new Promise((resolve) => setImmediate(resolve));
      // A later start prunes instead, and after a shutdown the next
      // session's host does.
      if (this.pruned || this.epoch !== epoch) return;
      this.pruned = true;
      const settings = SettingsManager.create(cwd, getAgentDir());
      const { days, error } = readRetention(settings.getSettings());
      if (error) this.report(new Error(`${error}; storage is kept`));
      if (days === undefined) return;
      await pruneSessions({
        root: sessionsRoot(),
        days,
        current,
        stopped: () => this.epoch !== epoch,
        onError: (failure) => this.report(failure),
      });
    })().catch((error) => this.report(error));
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
    const epoch = this.epoch;
    // Pi invalidates the context when it replaces the session, so read it
    // before waiting.
    const { cwd, modelRegistry } = ctx;
    const persistent = isPersistent(ctx);
    const fallback = ctx.sessionManager.getSessionId();
    // The previous harness releases its lock and storage first.
    await this.closing;
    const sessionId = this.sessionId ?? fallback;
    this.sessionId = sessionId;
    let lock: StorageLock | undefined;
    let storage: Storage;
    if (persistent) {
      const directory = sessionDirectory(sessionId);
      const acquired = acquireLock(directory);
      if ("owner" in acquired) {
        this.unavailable = `Agents of this session belong to another Pi process (PID ${acquired.owner}).`;
        throw new AgentError(this.unavailable);
      }
      lock = acquired;
      try {
        storage = await (this.options.openStorage ?? openStorage)(directory);
      } catch (error) {
        lock.release();
        throw error;
      }
    } else {
      storage = await (this.options.openStorage ?? openStorage)(undefined);
    }
    let harness: AgentHarness | undefined;
    let service: AgentService | undefined;
    try {
      const settingsManager = SettingsManager.create(cwd, getAgentDir());
      const { limit, error } = readWorkingLimit(settingsManager.getSettings());
      if (error) this.report(new Error(`${error}; agents aren't capped`));
      const models = await resolveModels(modelRegistry);
      const extensions = createAgentExtensions({
        ...(limit === undefined ? {} : { maxWorkingAgents: limit }),
        prompt: { trusted: () => this.trusted, skills: this.skills.get },
        resolveHelper: (request, defaults) => {
          const current = this.ctx;
          if (!current) throw new AgentError("Pi isn't ready for helpers yet");
          return resolveHelper(request, current, defaults, this.skills.get);
        },
      });
      harness = await openAgentHarness({
        storage,
        models,
        cwd,
        extensions,
        settings: createHarnessSettings(settingsManager),
        onReport: (error) => this.report(error),
      });
      service = await AgentService.start({
        harness: harness.harness,
        anchor: harness.anchor,
        extensions,
        parent: this.parent,
        onReport: (error) => this.report(error),
      });
      // A shutdown or session start meanwhile: don't resume work for a
      // session that is gone.
      if (this.epoch !== epoch)
        throw new AgentError("The session ended while agents opened");
      // Work a previous process left unfinished continues now.
      harness.harness.resume();
      this.service = service;
      this.harness = harness;
      this.lock = lock;
      this.persistent = persistent;
      this.unsubscribe = service.subscribe(() => this.emit());
      this.watchFailure(harness);
      this.emit();
      return service;
    } catch (error) {
      try {
        await service?.close();
      } finally {
        try {
          await harness?.close();
        } finally {
          lock?.release();
        }
      }
      throw error;
    }
  }

  /** Recover once the harness closes because its storage failed. */
  private watchFailure(harness: AgentHarness): void {
    const epoch = this.epoch;
    void harness.harness.closed.then((end) => {
      if (end.reason !== "failed" || this.harness !== harness) return;
      if (this.epoch !== epoch || this.recovering) return;
      // Recovery reports its own failures, so shutdown can wait for it.
      this.recovering = this.recover(end.error, epoch)
        .catch((failure) => this.report(failure))
        .finally(() => {
          this.recovering = undefined;
        });
    });
  }

  /**
   * Pause the agents and reopen their storage, which resumes interrupted
   * work, unless it failed within the last minute too: then the next use
   * reopens it. Memory storage is gone with its harness.
   */
  private async recover(error: unknown, epoch: number): Promise<void> {
    const persistent = this.persistent;
    try {
      await this.close({ failed: true });
    } catch (failure) {
      this.report(
        new Error(
          `Closing the failed agent storage failed: ${message(failure)}`,
        ),
      );
    }
    // A shutdown or another session took over meanwhile.
    if (this.epoch !== epoch) return;
    if (!persistent) {
      this.report(
        new Error(
          `Agent storage failed (${message(error)}); this session keeps agents in memory, so they are lost`,
        ),
      );
      return;
    }
    const now = Date.now();
    const again =
      this.failedAt !== undefined && now - this.failedAt < REOPEN_INTERVAL_MS;
    this.failedAt = now;
    const ctx = this.ctx;
    if (again || !ctx) {
      this.report(
        new Error(
          `Agent storage failed again (${message(error)}); agents stay paused until you use them`,
        ),
      );
      return;
    }
    this.report(
      new Error(
        `Agent storage failed (${message(error)}); reopening it, and agents continue`,
      ),
    );
    // Pi may shut the session down as it shows the notice.
    if (this.epoch !== epoch) return;
    try {
      await this.ensure(ctx);
    } catch (reopen) {
      // An open that a shutdown ended needs no notice.
      if (this.epoch === epoch) this.report(reopen);
    }
  }

  /** Report a failure; never throws, as it often runs in error handlers. */
  private report(error: unknown): void {
    notify(this.ctx, `pi-agents: ${message(error)}`);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Session shutdown: pause agents and release the storage. A recovery
   * underway stops instead of reopening. */
  async stop(): Promise<void> {
    this.epoch++;
    // Without a recovery or an open underway, the harness leaves at once,
    // so a use right after this call opens a new one.
    if (this.recovering) await this.recovering;
    if (this.opening) await this.opening.catch(() => {});
    await this.close();
  }

  /**
   * Close the open harness, if any, after earlier closes. Closing takes
   * over the harness's service and lock, so a harness opened meanwhile
   * keeps its own. `failed`: the harness closed itself after a storage
   * error, so closing it again may throw.
   */
  private close(options: { failed?: boolean } = {}): Promise<void> {
    const service = this.service;
    const harness = this.harness;
    const lock = this.lock;
    const unsubscribe = this.unsubscribe;
    this.service = undefined;
    this.harness = undefined;
    this.lock = undefined;
    this.unsubscribe = undefined;
    // A failed harness has nothing left to close, so its close may throw.
    const closeHarness = async () => {
      try {
        await harness?.close();
      } catch (error) {
        if (!options.failed) throw error;
      }
    };
    const closing = this.closing.then(async () => {
      unsubscribe?.();
      try {
        try {
          await service?.close();
        } catch (error) {
          // The harness goes in any case; the service's error stands.
          await closeHarness().catch(() => {});
          throw error;
        }
        await closeHarness();
      } finally {
        try {
          lock?.release();
        } finally {
          this.emit();
        }
      }
    });
    // Later opens wait for this close, but not for its errors.
    this.closing = closing.catch(() => {});
    return closing;
  }
}
