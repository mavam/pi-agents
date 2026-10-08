/**
 * Configuration in `pi-agents.json`: model guidance shown to the parent model
 * when it picks models for agents.
 */

import * as fs from "node:fs";
import { findProjectRoot, projectConfigFile, userConfigFile } from "./paths.js";

export interface AgentsConfig {
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

const ALLOWED_CONFIG_KEYS = new Set(["models"]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one user- or project-scoped configuration file. */
export function readConfig(
  filePath: string,
): AgentsConfig | string | undefined {
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
    return `Unsupported keys: ${unknownKeys.join(", ")}. Allowed keys: models.`;
  }

  const config: AgentsConfig = {};
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

/** Load model guidance from the user and, when trusted, the project. */
export function loadModelNotes(cwd: string, trusted: boolean): ModelNoteRule[] {
  const rules: ModelNoteRule[] = [];
  let order = 0;
  const load = (filePath: string, scope: ModelNoteRule["scope"]) => {
    const config = readConfig(filePath);
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
