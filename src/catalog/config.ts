import * as fs from "node:fs";

export type BundledWorkflowsSetting = boolean | Record<string, boolean>;

export interface WorkflowConfig {
  bundledWorkflows?: BundledWorkflowsSetting;
}

export interface BundledWorkflowPolicy {
  defaultEnabled: boolean;
  overrides: ReadonlyMap<string, boolean>;
}

const ALLOWED_CONFIG_KEYS = new Set(["bundledWorkflows"]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one user- or project-scoped workflow configuration file. */
export function readWorkflowConfig(
  filePath: string,
): WorkflowConfig | string | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    return `Could not parse JSON: ${toErrorMessage(error)}`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "The configuration must contain a single JSON object";
  }

  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !ALLOWED_CONFIG_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    return `Unsupported keys: ${unknownKeys.join(", ")}. Allowed keys: bundledWorkflows.`;
  }

  const setting = record.bundledWorkflows;
  if (setting === undefined) return {};
  if (typeof setting === "boolean") return { bundledWorkflows: setting };
  if (
    typeof setting !== "object" ||
    setting === null ||
    Array.isArray(setting) ||
    Object.values(setting).some((value) => typeof value !== "boolean")
  ) {
    return "Invalid 'bundledWorkflows' (must be a boolean or an object whose values are booleans)";
  }
  return {
    bundledWorkflows: { ...(setting as Record<string, boolean>) },
  };
}

/**
 * Layer one setting over the inherited policy. A scalar resets the policy for
 * every bundled workflow; an object changes only the named workflows. This
 * lets a project selectively re-enable a workflow after a user-level `false`.
 */
export function applyBundledWorkflowsSetting(
  inherited: BundledWorkflowPolicy,
  setting: BundledWorkflowsSetting | undefined,
): BundledWorkflowPolicy {
  if (setting === undefined) return inherited;
  if (typeof setting === "boolean") {
    return { defaultEnabled: setting, overrides: new Map() };
  }
  const overrides = new Map(inherited.overrides);
  for (const [name, enabled] of Object.entries(setting)) {
    overrides.set(name, enabled);
  }
  return { defaultEnabled: inherited.defaultEnabled, overrides };
}

export function bundledWorkflowEnabled(
  policy: BundledWorkflowPolicy,
  name: string,
): boolean {
  return policy.overrides.get(name) ?? policy.defaultEnabled;
}
