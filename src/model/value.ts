/** High-water mark for a single workflow value entering model context. */
export const MAX_MODEL_RESULT_CHARS = 200_000;

/** Convert a workflow value to its textual representation. */
export function valueText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? String(value));
}

/** Bound model-facing text while preserving an explicit retrieval path. */
export function truncateModelResult(text: string, fullResult: string): string {
  if (text.length <= MAX_MODEL_RESULT_CHARS) return text;
  const overflow = text.length - MAX_MODEL_RESULT_CHARS;
  return `${text.slice(0, MAX_MODEL_RESULT_CHARS)}\n… [truncated ${overflow} characters; full result: ${fullResult}]`;
}
