/**
 * Harness setup derived from Pi: Harness settings and the identity of model
 * requests read from Pi's settings, and execution environments. Pi has
 * configured HTTP already, since agents run in its process.
 */

import type { Context } from "@earendil-works/chord";
import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { type SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type {
  CompactionSettings,
  EnvTarget,
  HarnessSettings,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

type CompactionOverrides = NonNullable<CompactionSettings["modelOverrides"]>;

/**
 * Pi's per-model compaction token settings (`compaction.modelOverrides`),
 * keyed by exact `provider/modelId` as pi-durable keys them. Values Pi
 * would reject are left out, so the harness-wide setting applies instead.
 */
export function compactionOverrides(
  settings: unknown,
): CompactionOverrides | undefined {
  const raw = (settings as { compaction?: { modelOverrides?: unknown } })
    ?.compaction?.modelOverrides;
  if (typeof raw !== "object" || raw === null) return undefined;
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const overrides: Record<
    string,
    { reserveTokens?: number; keepRecentTokens?: number }
  > = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { reserveTokens, keepRecentTokens } = entry as Record<
      string,
      unknown
    >;
    const override = {
      ...(valid(reserveTokens) ? { reserveTokens } : {}),
      ...(valid(keepRecentTokens) ? { keepRecentTokens } : {}),
    };
    if (Object.keys(override).length > 0) overrides[model] = override;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

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
      // Without a model, Pi resolves the harness-wide values; pi-durable
      // applies the per-model ones itself, for the model it compacts for.
      const modelOverrides = compactionOverrides(settingsManager.getSettings());
      return {
        ...settingsManager.getCompactionSettings(),
        ...(modelOverrides ? { modelOverrides } : {}),
      };
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

/**
 * How agents' model requests identify themselves, as Pi's own do: a
 * detailed `User-Agent` with Pi's version, and attribution to Pi while
 * install telemetry is enabled. `PI_TELEMETRY` overrides the setting.
 */
export function harnessIdentity(
  settingsManager: SettingsManager,
  telemetry: string | undefined = process.env.PI_TELEMETRY,
): ClientIdentity {
  const enabled =
    telemetry === undefined
      ? settingsManager.getEnableInstallTelemetry()
      : ["1", "true", "yes"].includes(telemetry.toLowerCase());
  return {
    userAgent: "detailed",
    version: VERSION,
    attribution: enabled ? PI_ATTRIBUTION : null,
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
