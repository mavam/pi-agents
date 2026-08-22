/**
 * Display-path handling for human-facing result rendering.
 *
 * This is presentation logic and therefore lives in `ui/`, not in the pure
 * flow model: an invalid display path must never be able to abort execution.
 * Saved workflow definitions keep the strict (throwing) validator because
 * they are validated ahead of use and surface as file diagnostics; request
 * paths use the soft variant, which degrades to a warning.
 */

/** Dot path to a human-facing Markdown string in a workflow's final value. */
const DISPLAY_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Strict validation for saved-workflow frontmatter: an invalid `display`
 * there is a definition error and fails the file's validation.
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

/**
 * Recoverable validation for request-time `display`: an invalid value is
 * dropped with a warning and presentation falls back to the complete result.
 */
export function softDisplayPath(value: unknown): SoftDisplayPath {
  if (value === undefined) return {};
  try {
    return { display: normalizeDisplayPath(value) };
  } catch {
    return {
      warning: `Ignored invalid 'display' (must be a non-empty dot path); presentation falls back to the complete result.`,
    };
  }
}
