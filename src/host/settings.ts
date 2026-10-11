/**
 * Feature settings from Pi's merged settings, under `piAgents`.
 */

import { SETTINGS_KEY } from "./limit.js";

/** `piAgents.messaging`: whether agents may message each other. Off unless
 * it's `true`. */
export function readMessaging(settings: unknown): boolean {
  return section(settings)?.messaging === true;
}

/** `piAgents.panelRows`: the agent panel's height in rows, 0 to 9; 1 is a
 * summary line and 0 hides the panel until an agent starts. Anything else
 * leaves the default. */
export function readPanelRows(settings: unknown): number | undefined {
  const value = section(settings)?.panelRows;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 9
    ? value
    : undefined;
}

function section(settings: unknown): Record<string, unknown> | undefined {
  const value =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
