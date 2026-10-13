/** pi-agents' settings in Pi's merged settings. */

/** The settings key under which pi-agents reads its configuration. */
export const SETTINGS_KEY = "piAgents";

/**
 * A positive integer setting under `piAgents`. Absent means unset; anything
 * but a positive integer is an error.
 */
export function readPositiveInteger(
  settings: unknown,
  key: string,
): { value?: number; error?: string } {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section))
    return { error: `${SETTINGS_KEY} must be an object` };
  const value = (section as Record<string, unknown>)[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return {
      error: `${SETTINGS_KEY}.${key} must be a positive integer, not ${JSON.stringify(value)}`,
    };
  return { value };
}
