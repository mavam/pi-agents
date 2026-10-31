/** pi-agents' settings in Pi's merged settings. */

/** The settings key under which pi-agents reads its configuration. */
export const SETTINGS_KEY = "piAgents";

/** A setting under `piAgents`, or why the section isn't usable. */
function readSetting(
  settings: unknown,
  key: string,
): { value?: unknown; error?: string } {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section))
    return { error: `${SETTINGS_KEY} must be an object` };
  return { value: (section as Record<string, unknown>)[key] };
}

/**
 * A list of strings under `piAgents`. Absent means empty; anything but an
 * array of strings is an error.
 */
export function readStringList(
  settings: unknown,
  key: string,
): { value: string[]; error?: string } {
  const { value, error } = readSetting(settings, key);
  if (error) return { value: [], error };
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return {
      value: [],
      error: `${SETTINGS_KEY}.${key} must be a list of strings, not ${JSON.stringify(value)}`,
    };
  return { value: [...new Set(value as string[])] };
}

/**
 * A positive integer setting under `piAgents`. Absent means unset; anything
 * but a positive integer is an error.
 */
export function readPositiveInteger(
  settings: unknown,
  key: string,
): { value?: number; error?: string } {
  const { value, error } = readSetting(settings, key);
  if (error || value === undefined) return error ? { error } : {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return {
      error: `${SETTINGS_KEY}.${key} must be a positive integer, not ${JSON.stringify(value)}`,
    };
  return { value };
}
