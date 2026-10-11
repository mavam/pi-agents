/**
 * Feature settings from Pi's merged settings, under `piAgents`.
 */

import { SETTINGS_KEY } from "./limit.js";

/** `piAgents.messaging`: whether agents may message each other. Off unless
 * it's `true`. */
export function readMessaging(settings: unknown): boolean {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  return (
    typeof section === "object" &&
    section !== null &&
    (section as Record<string, unknown>).messaging === true
  );
}
