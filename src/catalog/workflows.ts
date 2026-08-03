/**
 * Saved-workflow discovery: pure YAML or JSON files (`.pi/workflows/*.yaml`,
 * `.yml`, `.json` — the extension decides the parser). One object per file:
 * name, description, trigger, display, on, debounce, params, optional doc
 * prose, and the flow expression (either a `flow:` tree or the flat
 * `agent:`/`task:` single-unit form).
 *
 * Discovery mirrors agents: user `~/.pi/agent/workflows` plus the nearest project
 * `.pi/workflows` walking up from cwd; project wins on name conflicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
import { findProjectResourceDir, userResourceDir } from "./paths.js";

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

/**
 * Keys that only exist in the flat single-unit form. Each maps to a field on
 * the normalized `AgentNode` ('agent' becomes 'name'), and each is rejected
 * alongside `flow:`.
 */
const FLAT_ONLY_KEYS = [
  "agent",
  "task",
  "model",
  "thinking",
  "skills",
  "tools",
  "cwd",
  "scope",
  "output",
];

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "trigger",
  "display",
  "on",
  "debounce",
  "params",
  "doc",
  "flow",
  // Flat single-unit form (sugar for flow: {kind: agent, …}):
  ...FLAT_ONLY_KEYS,
]);

/** The file extension decides the parser. */
const WORKFLOW_EXTENSIONS = [".yaml", ".yml", ".json"];

/** Flat-form keys that carry list values; everything else is a string. */
const FLAT_LIST_KEYS = new Set(["skills", "tools"]);

const WORKFLOW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Dot path into a workflow's final JSON value. */
const DISPLAY_PATH_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The flow expression: either an explicit `flow:` tree or the flat
 * single-unit form (`task:` plus any agent-call option), which normalizes to a
 * bare agent leaf. Without `agent:` the leaf is anonymous and runs as an
 * ad-hoc agent. The flat form is pure sugar: it must produce exactly the
 * `AgentNode` the equivalent `flow:` tree would.
 */
function extractRawFlow(
  fm: Record<string, unknown>,
): { ok: true; flow: unknown } | { ok: false; error: string } {
  const hasFlow = fm.flow !== undefined;
  const hasFlat = fm.agent !== undefined || fm.task !== undefined;
  if (hasFlow && hasFlat) {
    return {
      ok: false,
      error: "Use either 'flow:' or the flat 'agent:'/'task:' form, not both",
    };
  }
  if (hasFlow) {
    // Every flat-form key belongs on the agent node once 'flow:' is in play;
    // silently dropping one would make the sugar and the tree disagree.
    for (const key of FLAT_ONLY_KEYS) {
      if (fm[key] !== undefined) {
        return {
          ok: false,
          error: `'${key}' belongs to the flat agent form; with 'flow:' put it on the agent node`,
        };
      }
    }
    return { ok: true, flow: fm.flow };
  }
  if (hasFlat) {
    if (fm.agent !== undefined) {
      if (typeof fm.agent !== "string" || !fm.agent.trim()) {
        return {
          ok: false,
          error: "Invalid 'agent' (must be a non-empty string)",
        };
      }
    }
    if (fm.task === undefined) {
      return { ok: false, error: "The flat agent form requires 'task:'" };
    }
    const node: Record<string, unknown> = { kind: "agent" };
    for (const key of FLAT_ONLY_KEYS) {
      const value = fm[key];
      if (value === undefined) continue;
      if (FLAT_LIST_KEYS.has(key)) {
        if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) {
          return {
            ok: false,
            error: `Invalid '${key}' (must be an array of strings)`,
          };
        }
      } else if (typeof value !== "string") {
        return { ok: false, error: `Invalid '${key}' (must be a string)` };
      }
      // 'agent' is the flat spelling of the node's 'name'.
      if (key === "agent") node.name = (value as string).trim();
      else node[key] = value;
    }
    return { ok: true, flow: node };
  }
  return {
    ok: false,
    error:
      "No flow found: add a 'flow:' key, or the flat form ('task:' with an optional 'agent:')",
  };
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
  try {
    const parsed: unknown = filePath.endsWith(".json")
      ? JSON.parse(raw)
      : YAML.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return "A workflow file must contain a single YAML/JSON object";
    }
    fm = parsed as Record<string, unknown>;
  } catch (e) {
    return `Could not parse ${path.extname(filePath).slice(1)}: ${toErrorMessage(e)}`;
  }

  const unknownKeys = Object.keys(fm).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return `Unsupported keys: ${unknownKeys.join(", ")}. Allowed keys: ${[...ALLOWED_KEYS].join(", ")}.`;
  }
  if (fm.doc !== undefined && typeof fm.doc !== "string") {
    return "Invalid 'doc' (must be a string)";
  }
  if (typeof fm.name !== "string" || !WORKFLOW_NAME_RE.test(fm.name.trim())) {
    return `Missing or invalid 'name' (must match ${WORKFLOW_NAME_RE})`;
  }
  if (typeof fm.description !== "string" || !fm.description.trim()) {
    return "Missing or invalid 'description' (must be a non-empty string)";
  }
  if (fm.trigger !== undefined && typeof fm.trigger !== "string") {
    return "Invalid 'trigger' (must be a string)";
  }
  if (
    fm.display !== undefined &&
    (typeof fm.display !== "string" || !DISPLAY_PATH_RE.test(fm.display.trim()))
  ) {
    return "Invalid 'display' (must be a non-empty dot path)";
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

  const extracted = extractRawFlow(fm);
  if (!extracted.ok) return extracted.error;
  const rawFlow = extracted.flow;

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

  const doc = typeof fm.doc === "string" ? fm.doc.trim() : "";

  return {
    name: fm.name.trim(),
    description: fm.description.trim(),
    trigger: typeof fm.trigger === "string" ? fm.trigger.trim() : undefined,
    display: typeof fm.display === "string" ? fm.display.trim() : undefined,
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
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    if (entry.name.endsWith(".md")) {
      diagnostics.push({
        source,
        filePath,
        message:
          "Workflows are pure YAML/JSON files now; rename to .yaml (frontmatter keys become top-level keys, prose moves to 'doc:').",
      });
      continue;
    }
    if (!WORKFLOW_EXTENSIONS.includes(path.extname(entry.name))) continue;
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
  const projectWorkflowsDir = findProjectResourceDir(cwd, "workflows");
  const user =
    scope !== "project"
      ? loadWorkflowsFromDir(userResourceDir("workflows"), "user")
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
