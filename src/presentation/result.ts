/**
 * Presentation policy for workflow metadata and completed values.
 *
 * This module has no TUI or Pi dependencies. Catalog parsing, launch request
 * preparation, and UI rendering all use the same rules without depending on
 * one another.
 */

import { resolvePath } from "../model/interpolate.js";

/** Dot path to a human-facing Markdown string in a workflow's final value. */
const DISPLAY_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Strict validation for saved-workflow definitions. An invalid `display`
 * value makes the definition unavailable and produces a catalog diagnostic.
 */
export function normalizeDisplayPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DISPLAY_PATH_RE.test(value.trim())) {
    throw new Error("Invalid 'display' (must be a non-empty dot path)");
  }
  return value.trim();
}

export interface SoftDisplayPath {
  display?: string;
  warning?: string;
}

/** Normalize request-time `display` without preventing a run from starting. */
export function softDisplayPath(value: unknown): SoftDisplayPath {
  if (value === undefined) return {};
  try {
    return { display: normalizeDisplayPath(value) };
  } catch {
    return {
      warning:
        "Ignored invalid 'display' (must be a non-empty dot path); presentation falls back to the complete result.",
    };
  }
}

export interface SoftLabel {
  label?: string;
  warning?: string;
}

/** Normalize request-time labels. Invalid labels are presentation warnings. */
export function softLabel(value: unknown): SoftLabel {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      warning: "Ignored invalid 'label' (must be a non-empty string).",
    };
  }
  return { label: value.trim() };
}

export interface SelectedDisplayValue {
  /** The selected Markdown string, or the original value as a fallback. */
  value: unknown;
  /** Whether presentation selected a Markdown string from structured data. */
  selected: boolean;
  /** Why a declared path fell back to `report` or the complete result. */
  warning?: string;
}

/** Select the conventional top-level `report` string when one exists. */
function selectReportValue(value: unknown): SelectedDisplayValue {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).report === "string"
  ) {
    return {
      value: (value as Record<string, unknown>).report as string,
      selected: true,
    };
  }
  return { value, selected: false };
}

/**
 * Select a run's human-facing result. The fallback order is an explicit
 * `display` path, the top-level `report` convention, then the complete value.
 * Selection may warn but never throws.
 */
export function selectDisplayValue(
  value: unknown,
  display: string | undefined,
): SelectedDisplayValue {
  if (!display) return selectReportValue(value);
  const fallback = selectReportValue(value);
  const shown = fallback.selected
    ? "showing the `report` field"
    : "showing the raw result";
  const resolved = resolvePath(value, display.split("."));
  if (!resolved.found) {
    return {
      ...fallback,
      warning: `Display path \`${display}\` was not found; ${shown}.`,
    };
  }
  if (typeof resolved.value !== "string") {
    return {
      ...fallback,
      warning: `Display path \`${display}\` resolved to a non-string value; ${shown}.`,
    };
  }
  return { value: resolved.value, selected: true };
}
