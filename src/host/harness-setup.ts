/**
 * Harness setup derived from Pi, after Pi's experimental durable coding
 * agent (`experimental/durable/harness-setup.ts`): Harness settings and
 * execution environments. Pi has configured HTTP already, since agents run
 * in its process.
 */

import type { Context } from "@earendil-works/chord";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { EnvTarget, HarnessSettings } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(
  settingsManager: SettingsManager,
): HarnessSettings {
  return {
    get stream() {
      const provider = settingsManager.getProviderRetrySettings();
      const idle = settingsManager.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined
          ? {}
          : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settingsManager.getCompactionSettings();
    },
    get retry() {
      return settingsManager.getRetrySettings();
    },
    get steeringMode() {
      return settingsManager.getSteeringMode();
    },
    get followUpMode() {
      return settingsManager.getFollowUpMode();
    },
  };
}

/** One execution environment per directory, shared by every conversation in it. */
export class ExecutionEnvs {
  readonly #defaultCwd: string;
  readonly #envs = new Map<string, NodeExecutionEnv>();

  constructor(defaultCwd: string) {
    this.#defaultCwd = defaultCwd;
  }

  readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
    let env = this.#envs.get(cwd);
    if (env === undefined) {
      env = new NodeExecutionEnv({ cwd });
      this.#envs.set(cwd, env);
    }
    return env;
  };

  async cleanup(context: Context): Promise<void> {
    const envs = [...this.#envs.values()];
    this.#envs.clear();
    for (const env of envs) await env.cleanup(context);
  }
}
