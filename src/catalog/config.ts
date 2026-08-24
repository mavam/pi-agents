import * as fs from "node:fs";
import { findProjectRoot, projectConfigFile, userConfigFile } from "./paths.js";

export type BundledWorkflowsSetting = boolean | Record<string, boolean>;

export interface WorkflowConfig {
  bundledWorkflows?: BundledWorkflowsSetting;
  /** Provider-qualified model glob to planning guidance. */
  models?: Record<string, string>;
}

export interface ModelNoteRule {
  pattern: string;
  note: string;
  scope: "user" | "project";
  specificity: number;
  order: number;
}

export interface BundledWorkflowPolicy {
  defaultEnabled: boolean;
  overrides: ReadonlyMap<string, boolean>;
}

const ALLOWED_CONFIG_KEYS = new Set(["bundledWorkflows", "models"]);

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
    return `Unsupported keys: ${unknownKeys.join(", ")}. Allowed keys: bundledWorkflows, models.`;
  }

  const config: WorkflowConfig = {};
  const setting = record.bundledWorkflows;
  if (setting !== undefined) {
    if (typeof setting === "boolean") config.bundledWorkflows = setting;
    else if (
      typeof setting !== "object" ||
      setting === null ||
      Array.isArray(setting) ||
      Object.values(setting).some((value) => typeof value !== "boolean")
    ) {
      return "Invalid 'bundledWorkflows' (must be a boolean or an object whose values are booleans)";
    } else {
      config.bundledWorkflows = {
        ...(setting as Record<string, boolean>),
      };
    }
  }

  const models = record.models;
  if (models !== undefined) {
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models) ||
      Object.entries(models).some(
        ([pattern, note]) =>
          pattern.length === 0 || typeof note !== "string" || note.length === 0,
      )
    ) {
      return "Invalid 'models' (must be an object with non-empty glob keys and non-empty string values)";
    }
    config.models = { ...(models as Record<string, string>) };
  }
  return config;
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

function normalizedPattern(pattern: string): string {
  return pattern.includes("/") ? pattern : `*/${pattern}`;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = normalizedPattern(pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function patternSpecificity(pattern: string): number {
  const wildcard = pattern.indexOf("*");
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).length;
}

/** Load model guidance independently from workflow discovery. */
export function loadModelNotes(cwd: string, trusted: boolean): ModelNoteRule[] {
  const rules: ModelNoteRule[] = [];
  let order = 0;
  const load = (filePath: string, scope: ModelNoteRule["scope"]) => {
    const config = readWorkflowConfig(filePath);
    if (!config || typeof config === "string" || !config.models) return;
    for (const [pattern, note] of Object.entries(config.models)) {
      rules.push({
        pattern,
        note,
        scope,
        specificity: patternSpecificity(pattern),
        order: order++,
      });
    }
  };
  load(userConfigFile(), "user");
  if (trusted) {
    const root = findProjectRoot(cwd);
    if (root) load(projectConfigFile(root), "project");
  }
  return rules;
}

/** Pick the most specific matching note; project scope wins equal matches. */
export function resolveModelNote(
  rules: readonly ModelNoteRule[],
  model: string,
): string | undefined {
  return rules
    .filter((rule) => globMatches(rule.pattern, model))
    .sort(
      (left, right) =>
        right.specificity - left.specificity ||
        Number(right.scope === "project") - Number(left.scope === "project") ||
        right.order - left.order,
    )[0]?.note;
}
