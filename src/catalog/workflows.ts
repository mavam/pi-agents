/**
 * Saved-workflow discovery: `.pi/workflows/*.md` files with YAML frontmatter
 * (name, description, whenToUse, on, debounce, params) and the flow
 * expression in a fenced ```yaml or ```json block in the body. Prose around
 * the block is documentation.
 *
 * Discovery mirrors agents: user `~/.pi/workflows` plus the nearest project
 * `.pi/workflows` walking up from cwd; project wins on name conflicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import type {
  FlowNode,
  Scope,
  Source,
  WorkflowDef,
  WorkflowParamDef,
} from "../model/ast.js";
import { IDENTIFIER_RE } from "../model/ast.js";
import {
  FlowValidationError,
  parseFlowNode,
  validateFlow,
} from "../model/validate.js";
import type { Diagnostic } from "./agents.js";

export interface WorkflowDiscoveryResult {
  workflows: WorkflowDef[];
  diagnostics: Diagnostic[];
  projectWorkflowsDir: string | null;
}

/** pi events a workflow may declare in `on:`. */
export const HOOKABLE_EVENTS = [
  "session_start",
  "session_compact",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "model_select",
  "user_bash",
] as const;

const HOOKABLE_EVENT_SET: ReadonlySet<string> = new Set(HOOKABLE_EVENTS);

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "whenToUse",
  "on",
  "debounce",
  "params",
]);

const WORKFLOW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getUserWorkflowsDir(): string {
  return path.join(path.dirname(getAgentDir()), "workflows");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectWorkflowsDir(cwd: string): string | null {
  const userDir = path.resolve(getUserWorkflowsDir());
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, ".pi", "workflows");
    if (isDirectory(candidate) && path.resolve(candidate) !== userDir)
      return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Extract fenced ```yaml/```json blocks from a markdown body. */
export function extractFlowBlocks(
  body: string,
): Array<{ lang: string; content: string }> {
  const blocks: Array<{ lang: string; content: string }> = [];
  const fenceRe = /^```(yaml|yml|json)\s*\n([\s\S]*?)^```\s*$/gm;
  let match = fenceRe.exec(body);
  while (match !== null) {
    blocks.push({ lang: match[1] as string, content: match[2] as string });
    match = fenceRe.exec(body);
  }
  return blocks;
}

function parseParams(raw: unknown): WorkflowParamDef[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    return { error: "Invalid 'params' (must be a YAML array)" };
  const params: WorkflowParamDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let def: WorkflowParamDef;
    if (typeof entry === "string") {
      def = { name: entry.trim() };
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!["name", "description", "required", "default"].includes(key)) {
          return {
            error: `Invalid param key '${key}' (allowed: name, description, required, default)`,
          };
        }
      }
      if (typeof record.name !== "string" || !record.name.trim()) {
        return { error: "Invalid param (missing 'name')" };
      }
      if (
        record.description !== undefined &&
        typeof record.description !== "string"
      ) {
        return {
          error: `Invalid param '${record.name}': 'description' must be a string`,
        };
      }
      if (
        record.required !== undefined &&
        typeof record.required !== "boolean"
      ) {
        return {
          error: `Invalid param '${record.name}': 'required' must be a boolean`,
        };
      }
      if (record.default !== undefined && typeof record.default !== "string") {
        return {
          error: `Invalid param '${record.name}': 'default' must be a string`,
        };
      }
      def = {
        name: record.name.trim(),
        description: record.description as string | undefined,
        required: record.required as boolean | undefined,
        default: record.default as string | undefined,
      };
    } else {
      return {
        error:
          "Invalid param entry (must be a string or an object with 'name')",
      };
    }
    if (!IDENTIFIER_RE.test(def.name)) {
      return {
        error: `Invalid param name '${def.name}' (must match ${IDENTIFIER_RE})`,
      };
    }
    if (seen.has(def.name)) return { error: `Duplicate param '${def.name}'` };
    seen.add(def.name);
    params.push(def);
  }
  return params;
}

/** Implicit param carrying the triggering event payload for hook workflows. */
export const EVENT_PARAM: WorkflowParamDef = {
  name: "event",
  description:
    "JSON payload of the triggering pi event (bound automatically for event-triggered runs)",
};

interface ParsedWorkflowFile extends Omit<WorkflowDef, "flow"> {
  /** Raw parsed flow value, pre-validation. */
  rawFlow: unknown;
  flow: FlowNode;
}

/** Returns a parsed workflow on success, or an error message string. */
export function parseWorkflowFile(
  filePath: string,
  source: Source,
): ParsedWorkflowFile | string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return `Could not read file: ${toErrorMessage(e)}`;
  }

  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    fm = parsed.frontmatter;
    body = parsed.body;
  } catch (e) {
    return `Could not parse frontmatter: ${toErrorMessage(e)}`;
  }

  const unknownKeys = Object.keys(fm).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return `Unsupported frontmatter keys: ${unknownKeys.join(", ")}. Allowed keys: ${[...ALLOWED_KEYS].join(", ")}.`;
  }
  if (typeof fm.name !== "string" || !WORKFLOW_NAME_RE.test(fm.name.trim())) {
    return `Missing or invalid 'name' (must match ${WORKFLOW_NAME_RE})`;
  }
  if (typeof fm.description !== "string" || !fm.description.trim()) {
    return "Missing or invalid 'description' (must be a non-empty string)";
  }
  if (fm.whenToUse !== undefined && typeof fm.whenToUse !== "string") {
    return "Invalid 'whenToUse' (must be a string)";
  }
  if (
    fm.on !== undefined &&
    (!Array.isArray(fm.on) || fm.on.some((e) => typeof e !== "string"))
  ) {
    return "Invalid 'on' (must be a YAML array of pi event names)";
  }
  if (Array.isArray(fm.on)) {
    const unknown = (fm.on as string[]).filter(
      (e) => !HOOKABLE_EVENT_SET.has(e.trim()),
    );
    if (unknown.length > 0) {
      return `Unknown event(s) in 'on': ${unknown.join(", ")}. Hookable events: ${HOOKABLE_EVENTS.join(", ")}`;
    }
  }
  if (
    fm.debounce !== undefined &&
    (typeof fm.debounce !== "number" || fm.debounce < 0)
  ) {
    return "Invalid 'debounce' (must be a non-negative number of milliseconds)";
  }
  const params = parseParams(fm.params);
  if ("error" in params) return params.error;

  const blocks = extractFlowBlocks(body);
  if (blocks.length === 0) {
    return "No flow found: add a fenced ```yaml or ```json block with the flow expression";
  }
  if (blocks.length > 1) {
    return `Found ${blocks.length} fenced flow blocks; a workflow file must contain exactly one`;
  }
  const block = blocks[0] as { lang: string; content: string };
  let rawFlow: unknown;
  try {
    rawFlow = YAML.parse(block.content);
  } catch (e) {
    return `Could not parse the ${block.lang} flow block: ${toErrorMessage(e)}`;
  }

  const on = fm.on
    ? [...new Set((fm.on as string[]).map((e) => e.trim()).filter(Boolean))]
    : undefined;
  // Hook workflows receive the triggering event payload as {params.event}.
  const allParams =
    on && on.length > 0 && !params.some((p) => p.name === EVENT_PARAM.name)
      ? [...params, EVENT_PARAM]
      : params;

  const issues: { path: string; message: string }[] = [];
  const flow = parseFlowNode(rawFlow, "$", issues);
  if (!flow || issues.length > 0) {
    const detail = issues
      .map((issue) => `at ${issue.path}: ${issue.message}`)
      .join("; ");
    return `Invalid flow: ${detail || "not a flow node"}`;
  }

  const doc = body
    .replace(/^```(yaml|yml|json)\s*\n[\s\S]*?^```\s*$/gm, "")
    .trim();

  return {
    name: fm.name.trim(),
    description: fm.description.trim(),
    whenToUse:
      typeof fm.whenToUse === "string" ? fm.whenToUse.trim() : undefined,
    on,
    debounce: fm.debounce as number | undefined,
    params: allParams,
    rawFlow,
    flow,
    doc,
    source,
    filePath,
  };
}

function loadWorkflowsFromDir(
  dir: string,
  source: Source,
): { workflows: ParsedWorkflowFile[]; diagnostics: Diagnostic[] } {
  const workflows: ParsedWorkflowFile[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!fs.existsSync(dir)) return { workflows, diagnostics };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    diagnostics.push({
      source,
      filePath: dir,
      message: `Could not read directory: ${toErrorMessage(e)}`,
    });
    return { workflows, diagnostics };
  }
  for (const entry of entries) {
    if (
      !entry.name.endsWith(".md") ||
      (!entry.isFile() && !entry.isSymbolicLink())
    )
      continue;
    const filePath = path.join(dir, entry.name);
    const result = parseWorkflowFile(filePath, source);
    if (typeof result === "string")
      diagnostics.push({ source, filePath, message: result });
    else workflows.push(result);
  }
  return { workflows, diagnostics };
}

export function discoverWorkflows(
  cwd: string,
  scope: Scope,
): WorkflowDiscoveryResult {
  const projectWorkflowsDir = findNearestProjectWorkflowsDir(cwd);
  const user =
    scope !== "project"
      ? loadWorkflowsFromDir(getUserWorkflowsDir(), "user")
      : { workflows: [], diagnostics: [] };
  const project =
    scope !== "user" && projectWorkflowsDir
      ? loadWorkflowsFromDir(projectWorkflowsDir, "project")
      : { workflows: [], diagnostics: [] };

  // Merge by name; project wins.
  const merged = new Map<string, ParsedWorkflowFile>();
  for (const wf of user.workflows) merged.set(wf.name, wf);
  for (const wf of project.workflows) merged.set(wf.name, wf);

  const diagnostics = [...user.diagnostics, ...project.diagnostics];

  // Cross-validate every definition against the merged set (references,
  // cycles, binding scopes). Invalid definitions are excluded so they can
  // never run half-checked.
  const resolveWorkflow = (name: string) => merged.get(name);
  const valid: WorkflowDef[] = [];
  for (const wf of merged.values()) {
    try {
      validateFlow(wf.rawFlow, {
        resolveWorkflow,
        selfName: wf.name,
        params: wf.params,
      });
      const { rawFlow: _rawFlow, ...def } = wf;
      valid.push(def);
    } catch (error) {
      const message =
        error instanceof FlowValidationError
          ? error.message
          : `Flow validation failed: ${toErrorMessage(error)}`;
      diagnostics.push({ source: wf.source, filePath: wf.filePath, message });
    }
  }

  return { workflows: valid, diagnostics, projectWorkflowsDir };
}

export function resolveWorkflowByName(
  workflows: WorkflowDef[],
  name: string,
): WorkflowDef | undefined {
  return (
    workflows.find((wf) => wf.name === name) ??
    workflows.find((wf) => wf.name.toLowerCase() === name.toLowerCase())
  );
}
