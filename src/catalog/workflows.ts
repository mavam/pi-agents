/**
 * Saved-workflow discovery: pure YAML or JSON files (`.pi/workflows/*.yaml`,
 * `.yml`, `.json` — the extension decides the parser). One object per file:
 * name, description, trigger, display, on, debounce, params, optional doc
 * prose, and the flow expression (either a `flow:` tree or the flat
 * `profile:`/`task:` single-unit form).
 *
 * Discovery layers package-bundled defaults, user
 * `~/.pi/agent/workflows`, and the nearest project `.pi/workflows` walking up
 * from cwd. Later layers win on name conflicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type {
  FlowNode,
  Scope,
  Source,
  WorkflowDef,
  WorkflowParamDef,
  WorkflowSource,
} from "../model/ast.js";
import { IDENTIFIER_RE } from "../model/ast.js";
import {
  FlowValidationError,
  parseFlowNode,
  validateFlow,
} from "../model/validate.js";
import { normalizeDisplayPath } from "../presentation/result.js";
import type { Diagnostic } from "./agents.js";
import {
  applyBundledWorkflowsSetting,
  type BundledWorkflowPolicy,
  bundledWorkflowEnabled,
  readWorkflowConfig,
} from "./config.js";
import {
  findProjectRoot,
  projectConfigFile,
  projectResourceDir,
  userConfigFile,
  userResourceDir,
} from "./paths.js";

export interface WorkflowDiagnostic extends Omit<Diagnostic, "source"> {
  source: WorkflowSource;
}

export interface WorkflowDiscoveryResult {
  workflows: WorkflowDef[];
  diagnostics: WorkflowDiagnostic[];
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
 * Keys that only exist in the flat single-unit form. Each maps directly to a
 * field on the normalized `AgentNode` and is rejected alongside `flow:`.
 */
const FLAT_ONLY_KEYS = [
  "profile",
  "task",
  "model",
  "thinking",
  "skills",
  "tools",
  "cwd",
  "scope",
  "json",
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

/** Standard workflow files shipped unchanged in the npm package. */
export const BUNDLED_WORKFLOWS_DIR = fileURLToPath(
  new URL("../../.pi/workflows/", import.meta.url),
);

/** Flat-form keys that carry list values; everything else is a string. */
const FLAT_LIST_KEYS = new Set(["skills", "tools"]);

const WORKFLOW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The flow expression: either an explicit `flow:` tree or the flat
 * single-unit form (`task:` plus any agent-call option), which normalizes to a
 * bare agent leaf. Without `profile:` the leaf is anonymous and runs as an
 * ad-hoc agent. The flat form is pure sugar: it must produce exactly the
 * `AgentNode` the equivalent `flow:` tree would.
 */
function extractRawFlow(
  fm: Record<string, unknown>,
): { ok: true; flow: unknown } | { ok: false; error: string } {
  const hasFlow = fm.flow !== undefined;
  const hasFlat = fm.profile !== undefined || fm.task !== undefined;
  if (hasFlow && hasFlat) {
    return {
      ok: false,
      error: "Use either 'flow:' or the flat 'profile:'/'task:' form, not both",
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
    if (fm.profile !== undefined) {
      if (typeof fm.profile !== "string" || !fm.profile.trim()) {
        return {
          ok: false,
          error: "Invalid 'profile' (must be a non-empty string)",
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
      if (key === "json") {
        node.json = value;
        continue;
      }
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
      node[key] = key === "profile" ? (value as string).trim() : value;
    }
    return { ok: true, flow: node };
  }
  return {
    ok: false,
    error:
      "No flow found: add a 'flow:' key, or the flat form ('task:' with an optional 'profile:')",
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
  source: WorkflowSource,
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

  if (Object.hasOwn(fm, "output")) {
    return "The 'output' field was removed; omit it for string results or replace it with a concrete 'json' schema";
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
  let display: string | undefined;
  try {
    display = normalizeDisplayPath(fm.display);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
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
    display,
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
  source: WorkflowSource,
): { workflows: ParsedWorkflowFile[]; diagnostics: WorkflowDiagnostic[] } {
  const workflows: ParsedWorkflowFile[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
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

interface ConfigOrigin {
  source: Source;
  filePath: string;
}

interface BundledPolicyState {
  policy: BundledWorkflowPolicy;
  defaultOrigin?: ConfigOrigin;
  overrideOrigins: Map<string, ConfigOrigin>;
}

function applyConfigFile(
  inherited: BundledPolicyState,
  filePath: string,
  source: Source,
  bundledNames: ReadonlySet<string>,
  diagnostics: WorkflowDiagnostic[],
): BundledPolicyState {
  const config = readWorkflowConfig(filePath);
  if (typeof config === "string") {
    diagnostics.push({ source, filePath, message: config });
    return inherited;
  }
  const setting = config?.bundledWorkflows;
  if (setting === undefined) return inherited;

  const origin = { source, filePath };
  if (typeof setting === "object") {
    for (const name of Object.keys(setting)) {
      if (!bundledNames.has(name)) {
        diagnostics.push({
          source,
          filePath,
          message: `Unknown bundled workflow '${name}'. Available: ${[...bundledNames].sort().join(", ") || "none"}.`,
        });
      }
    }
  }

  const policy = applyBundledWorkflowsSetting(inherited.policy, setting);
  if (typeof setting === "boolean") {
    return { policy, defaultOrigin: origin, overrideOrigins: new Map() };
  }
  const overrideOrigins = new Map(inherited.overrideOrigins);
  for (const name of Object.keys(setting)) overrideOrigins.set(name, origin);
  return {
    policy,
    defaultOrigin: inherited.defaultOrigin,
    overrideOrigins,
  };
}

function workflowReferences(node: FlowNode): Set<string> {
  const names = new Set<string>();
  const visit = (current: FlowNode): void => {
    switch (current.kind) {
      case "agent":
      case "value":
        return;
      case "sequence":
        for (const step of current.steps) visit(step);
        return;
      case "parallel":
        for (const branch of Object.values(current.branches)) visit(branch);
        return;
      case "map":
      case "loop":
      case "while":
        visit(current.body);
        return;
      case "switch":
        for (const arm of current.cases) visit(arm.then);
        visit(current.else);
        return;
      case "workflow":
        names.add(current.name);
        return;
    }
  };
  visit(node);
  return names;
}

interface DisableCause extends ConfigOrigin {
  rootName: string;
}

function pruneDisabledBundledDependents(
  merged: Map<string, ParsedWorkflowFile>,
  allBundled: ParsedWorkflowFile[],
  state: BundledPolicyState,
  diagnostics: WorkflowDiagnostic[],
): void {
  const bundledNames = new Set(allBundled.map((workflow) => workflow.name));
  const causes = new Map<string, DisableCause>();
  for (const workflow of allBundled) {
    if (bundledWorkflowEnabled(state.policy, workflow.name)) continue;
    const origin =
      state.overrideOrigins.get(workflow.name) ?? state.defaultOrigin;
    if (origin)
      causes.set(workflow.name, { ...origin, rootName: workflow.name });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const workflow of allBundled) {
      if (merged.get(workflow.name) !== workflow) continue;
      const missing = [...workflowReferences(workflow.flow)].find(
        (name) => bundledNames.has(name) && !merged.has(name),
      );
      if (!missing) continue;

      merged.delete(workflow.name);
      changed = true;
      const cause = causes.get(missing);
      if (!cause) continue;
      causes.set(workflow.name, cause);
      diagnostics.push({
        source: cause.source,
        filePath: cause.filePath,
        message: `Disabling bundled workflow '${cause.rootName}' also disables dependent bundled workflow '${workflow.name}'.`,
      });
    }
  }
}

const EMPTY_WORKFLOW_LOAD = {
  workflows: [] as ParsedWorkflowFile[],
  diagnostics: [] as WorkflowDiagnostic[],
};

export function discoverWorkflows(
  cwd: string,
  scope: Scope,
): WorkflowDiscoveryResult {
  const projectRoot = findProjectRoot(cwd);
  const projectWorkflowsDir =
    projectRoot === null ? null : projectResourceDir(projectRoot, "workflows");
  const userWorkflowsDir = userResourceDir("workflows");
  const diagnostics: WorkflowDiagnostic[] = [];

  const bundled =
    scope !== "project"
      ? loadWorkflowsFromDir(BUNDLED_WORKFLOWS_DIR, "bundled")
      : EMPTY_WORKFLOW_LOAD;
  const bundledNames = new Set(
    bundled.workflows.map((workflow) => workflow.name),
  );
  let policyState: BundledPolicyState = {
    policy: { defaultEnabled: true, overrides: new Map() },
    overrideOrigins: new Map(),
  };
  if (scope !== "project") {
    policyState = applyConfigFile(
      policyState,
      userConfigFile(),
      "user",
      bundledNames,
      diagnostics,
    );
    if (scope !== "user" && projectRoot !== null) {
      policyState = applyConfigFile(
        policyState,
        projectConfigFile(projectRoot),
        "project",
        bundledNames,
        diagnostics,
      );
    }
  }

  const user =
    scope !== "project"
      ? loadWorkflowsFromDir(userWorkflowsDir, "user")
      : EMPTY_WORKFLOW_LOAD;
  const project =
    scope !== "user" && projectWorkflowsDir
      ? loadWorkflowsFromDir(projectWorkflowsDir, "project")
      : EMPTY_WORKFLOW_LOAD;

  // Merge by name: user definitions override bundled defaults, and project
  // definitions override both.
  const merged = new Map<string, ParsedWorkflowFile>();
  for (const workflow of bundled.workflows) {
    if (bundledWorkflowEnabled(policyState.policy, workflow.name)) {
      merged.set(workflow.name, workflow);
    }
  }
  for (const wf of user.workflows) merged.set(wf.name, wf);
  for (const wf of project.workflows) merged.set(wf.name, wf);

  pruneDisabledBundledDependents(
    merged,
    bundled.workflows,
    policyState,
    diagnostics,
  );
  diagnostics.push(
    ...bundled.diagnostics,
    ...user.diagnostics,
    ...project.diagnostics,
  );

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

/** Expand a saved workflow for catalog previews without starting a run. */
export function expandSavedWorkflow(
  name: string,
  cwd: string,
  scope: Scope = "both",
): { name: string; flow: FlowNode } | undefined {
  try {
    const { workflows } = discoverWorkflows(cwd, scope);
    const def = resolveWorkflowByName(workflows, name);
    if (!def) return undefined;
    const flow = validateFlow(structuredClone(def.flow) as unknown, {
      resolveWorkflow: (candidate) =>
        resolveWorkflowByName(workflows, candidate),
      selfName: def.name,
      params: def.params,
    });
    return { name: def.name, flow };
  } catch {
    return undefined;
  }
}
