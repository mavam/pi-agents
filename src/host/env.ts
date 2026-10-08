/**
 * Execution environments and Harness settings derived from Pi.
 */

import type { Context } from "@earendil-works/chord";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { EnvTarget, HarnessSettings } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** One local environment per working directory, shared by its agents. */
export class ExecutionEnvs {
  private readonly envs = new Map<string, NodeExecutionEnv>();

  constructor(private readonly defaultCwd: string) {}

  readonly env = ({ cwd }: EnvTarget): NodeExecutionEnv => {
    const directory = cwd ?? this.defaultCwd;
    let env = this.envs.get(directory);
    if (env === undefined) {
      env = new NodeExecutionEnv({ cwd: directory });
      this.envs.set(directory, env);
    }
    return env;
  };

  async cleanup(context: Context): Promise<void> {
    const envs = [...this.envs.values()];
    this.envs.clear();
    for (const env of envs) await env.cleanup(context);
  }
}

/** Run policy read live from Pi's settings. */
export function createHarnessSettings(
  settings: SettingsManager,
): HarnessSettings {
  return {
    get stream() {
      const provider = settings.getProviderRetrySettings();
      const idle = settings.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined
          ? {}
          : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settings.getCompactionSettings();
    },
    get retry() {
      return settings.getRetrySettings();
    },
    get steeringMode() {
      return settings.getSteeringMode();
    },
    get followUpMode() {
      return settings.getFollowUpMode();
    },
  };
}
