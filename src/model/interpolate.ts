/**
 * Template engine for task strings.
 *
 * A template may contain references like `{name}`, `{name.dot.path}`, or
 * `{params.target}`. Only brace groups whose content matches the reference
 * grammar are treated as references; anything else (e.g. `{done: boolean}`
 * in prose) passes through literally. `{{` and `}}` escape literal braces
 * for text that would otherwise parse as a reference.
 */

/** Matches reference content: a root identifier plus an optional dot path. */
const REFERENCE_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/** Per-reference cap on interpolated text. */
export const MAX_INTERPOLATION_CHARS = 32_000;

export interface TemplateRef {
  /** Root name, e.g. "review" in "{review.issues}". */
  root: string;
  /** Dot-path segments after the root. */
  path: string[];
  /** The full reference text including braces, for error messages. */
  raw: string;
}

export type TemplatePart =
  | { kind: "text"; text: string }
  | ({ kind: "ref" } & TemplateRef);

export class InterpolationError extends Error {}

/** Split a template into literal text and references. Never throws. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{" && template[i + 1] === "{") {
      text += "{";
      i += 2;
      continue;
    }
    if (ch === "}" && template[i + 1] === "}") {
      text += "}";
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = template.indexOf("}", i + 1);
      const content = close === -1 ? "" : template.slice(i + 1, close);
      if (close !== -1 && REFERENCE_RE.test(content)) {
        if (text) {
          parts.push({ kind: "text", text });
          text = "";
        }
        const [root, ...path] = content.split(".");
        parts.push({
          kind: "ref",
          root: root as string,
          path,
          raw: `{${content}}`,
        });
        i = close + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  if (text) parts.push({ kind: "text", text });
  return parts;
}

/** All references in a template, for static validation. */
export function templateRefs(template: string): TemplateRef[] {
  return parseTemplate(template).filter((part) => part.kind === "ref");
}

/** True when the template is exactly one reference and nothing else (required for `map.over`). */
export function isSingleReference(template: string): boolean {
  const parts = parseTemplate(template);
  return parts.length === 1 && parts[0]?.kind === "ref";
}

export interface Resolution {
  found: boolean;
  value?: unknown;
}

/** Resolves a reference's root name to a value. */
export type RootResolver = (root: string) => Resolution;

/** Navigate a dot path into a JSON value. Array indices are numeric segments. */
export function resolvePath(value: unknown, path: string[]): Resolution {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** Render a JSON value as prompt text, capped per reference. */
export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  if (text.length <= MAX_INTERPOLATION_CHARS) return text;
  const overflow = text.length - MAX_INTERPOLATION_CHARS;
  return `${text.slice(0, MAX_INTERPOLATION_CHARS)}\n… [truncated ${overflow} characters]`;
}

/**
 * Interpolate a template against resolved roots.
 *
 * Throws InterpolationError when a root is unknown (should have been caught
 * statically) or a dot path does not resolve at runtime. A root that resolves
 * to `undefined` (e.g. `{last}` on iteration 0) renders as "" regardless of
 * any dot path.
 */
export function renderTemplate(
  template: string,
  resolve: RootResolver,
): string {
  let out = "";
  for (const part of parseTemplate(template)) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const root = resolve(part.root);
    if (!root.found) {
      throw new InterpolationError(`unknown reference ${part.raw}`);
    }
    if (root.value === undefined) {
      continue;
    }
    const resolved =
      part.path.length === 0 ? root : resolvePath(root.value, part.path);
    if (!resolved.found) {
      throw new InterpolationError(
        `reference ${part.raw}: path '${part.path.join(".")}' not found in {${part.root}}`,
      );
    }
    out += stringifyValue(resolved.value);
  }
  return out;
}
