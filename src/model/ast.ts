/**
 * Pure data model for the workflow algebra.
 *
 * Every node is an expression that yields a JSON value. Composition is purely
 * structural: there are no id-based cross-references, so any subtree is a
 * valid workflow on its own.
 *
 * This module has zero pi imports and no side effects.
 */

export type Source = "user" | "project";

export type Scope = Source | "both";

/**
 * Clamp a discovery scope by project trust: untrusted projects contribute no
 * agents or workflows, so everything degrades to user scope.
 */
export function effectiveScope(
  requested: Scope | undefined,
  trusted: boolean,
  fallback: Scope = "both",
): Scope {
  const scope = requested ?? fallback;
  return trusted ? scope : "user";
}

export type OutputMode = "text" | "json";

/** Fields shared by every node kind. */
export interface BaseNode {
  /**
   * Binding name for this node's value. Legal only on direct steps of a
   * `sequence`; later steps of the same sequence reference it as `{name}`.
   */
  as?: string;
  /** Optional human-readable label used in rendering. */
  label?: string;
}

/**
 * Display label for agent calls that name no profile (ad-hoc delegation).
 * Purely presentational; `"ad-hoc"` is not a reserved agent name.
 */
export const ADHOC_LABEL = "ad-hoc";

/** Leaf node: run one delegated agent on a task. */
export interface AgentNode extends BaseNode {
  kind: "agent";
  /**
   * Agent name (matches a discovered agent's frontmatter `name`). When
   * absent, the task runs as an anonymous ad-hoc agent: no catalog lookup,
   * no profile system prompt, default tools, session model/thinking.
   */
  name?: string;
  /** Task prompt; may interpolate `{bindings}`. */
  task: string;
  /** How to interpret the agent's final output. Default: "text". */
  output?: OutputMode;
  /** Model override for this node (wins over the agent file). */
  model?: string;
  /** Thinking-level override for this node (wins over the agent file). */
  thinking?: string;
  /** Working directory override for the delegated process. */
  cwd?: string;
  /** Agent discovery scope override. */
  scope?: Scope;
}

/** Run steps in order; the sequence's value is the last step's value. */
export interface SequenceNode extends BaseNode {
  kind: "sequence";
  steps: FlowNode[];
}

export type ParMode = "all" | "any" | { quorum: number };

/** Reducer: a synthetic agent call that folds collected results into one value. */
export interface Reduce {
  /** Agent name; absent runs the reducer as an anonymous ad-hoc agent. */
  agent?: string;
  /** Task prompt; interpolates `{branches}` (parallel) or `{items}` (map). */
  task: string;
  output?: OutputMode;
}

/**
 * Run named branches concurrently and combine their values (fused fork+join).
 *
 * Value: mode "all"/quorum yields `{branch: value}`; mode "any" yields the
 * winning branch's value directly. With `reduce`, the reducer's value
 * replaces the collected form.
 */
export interface ParallelNode extends BaseNode {
  kind: "parallel";
  branches: Record<string, FlowNode>;
  /** Completion mode. Default: "all". */
  mode?: ParMode;
  /** Failure policy. Default: "fail" (fail fast, cancel siblings). */
  onError?: "fail" | "collect";
  /** Cap on simultaneously running branches. */
  concurrency?: number;
  reduce?: Reduce;
}

/**
 * Dynamic fan-out: instantiate `body` once per element of the array that
 * `over` resolves to at runtime. The body sees `{item}` and `{index}`.
 * Value: array of body values in input order, or the reducer's value.
 */
export interface MapNode extends BaseNode {
  kind: "map";
  /** A single-reference template (e.g. "{files}" or "{scout.files}") that must resolve to a JSON array. */
  over: string;
  body: FlowNode;
  concurrency?: number;
  reduce?: Reduce;
}

/**
 * Repeat `body` until `until` holds or `max` iterations have run.
 * The body sees `{iteration}` (0-based) and `{last}` (previous iteration's
 * value; empty on iteration 0). Value: last executed iteration's value.
 */
export interface LoopNode extends BaseNode {
  kind: "loop";
  body: FlowNode;
  max: number;
  until?: Predicate;
}

/** One arm of a `switch`: run `then` when `when` holds over the subject. */
export interface SwitchCase {
  when: Predicate;
  then: FlowNode;
}

/**
 * Exclusive, ordered, total conditional: evaluate `cases` in definition order
 * against the value `on` resolves to and run the first arm whose predicate
 * holds, or `else` when none match. Exactly one arm runs; its value is the
 * switch's value. Arms see the same environment as the switch itself.
 */
export interface SwitchNode extends BaseNode {
  kind: "switch";
  /** A single-reference template (like `map.over`) naming the value to test. */
  on: string;
  /** Ordered arms; the first whose predicate holds runs. */
  cases: SwitchCase[];
  /** Required fallback arm — makes the node total. */
  else: FlowNode;
}

/**
 * Pure data leaf: yields `value` with every string interpolated. A string
 * that is exactly one `{reference}` substitutes the referenced JSON value
 * itself (type-preserving); any other string interpolates as text. No agent
 * runs.
 */
export interface ValueNode extends BaseNode {
  kind: "value";
  value: unknown;
}

/**
 * Invoke a saved workflow by name. Expanded (inlined) at validation time with
 * cycle detection; inside the inlined body only `{params.*}` and its own
 * bindings resolve — caller bindings are invisible. The `params` values are
 * template strings interpolated in the caller's scope.
 */
export interface WorkflowRefNode extends BaseNode {
  kind: "workflow";
  name: string;
  params?: Record<string, string>;
  /** Inlined flow of the referenced workflow. Derived during expansion; never author-supplied. */
  body?: FlowNode;
  /** Declared params of the referenced workflow. Derived during expansion. */
  paramDefs?: WorkflowParamDef[];
}

export type FlowNode =
  | AgentNode
  | SequenceNode
  | ParallelNode
  | MapNode
  | LoopNode
  | SwitchNode
  | ValueNode
  | WorkflowRefNode;

export type NodeKind = FlowNode["kind"];

/** Condition language for `loop.until` and `switch.cases[].when`. Paths are dot-paths into the subject JSON value; "" addresses the whole value. */
export type Predicate =
  | { eq: [path: string, value: string | number | boolean | null] }
  | { ne: [path: string, value: string | number | boolean | null] }
  | { gt: [path: string, value: number] }
  | { lt: [path: string, value: number] }
  | { exists: string }
  | { empty: string }
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate };

export interface Budgets {
  /** Maximum delegation depth (workflows spawning workflows across processes). */
  maxDepth?: number;
  /** Global cap on simultaneously running agents. */
  maxParallelism?: number;
  /** Cap applied to every loop's iterations. */
  maxIterations?: number;
  /** Total number of agent spawns (reducers included) a run may consume. */
  maxAgents?: number;
}

export const DEFAULT_BUDGETS: Required<Budgets> = {
  maxDepth: 3,
  maxParallelism: 4,
  maxIterations: 10,
  maxAgents: 50,
};

export interface WorkflowParamDef {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

/** The minimal shape validation needs to inline a workflow reference. */
export interface WorkflowLike {
  name: string;
  params: WorkflowParamDef[];
  flow: FlowNode;
}

/** A saved workflow definition discovered from a .pi/workflows/*.md file. */
export interface WorkflowDef extends WorkflowLike {
  description: string;
  trigger?: string;
  /** pi event names that trigger this workflow (background runs). */
  on?: string[];
  /** Trailing-edge debounce for event triggers, in milliseconds. */
  debounce?: number;
  /** Documentation prose from the file body. */
  doc: string;
  source: Source;
  filePath: string;
}

/** Names with fixed meaning in templates; `as` bindings may not use them. */
export const RESERVED_ROOTS = new Set([
  "previous",
  "item",
  "index",
  "iteration",
  "last",
  "params",
  "branches",
  "items",
]);

/** Valid `as` binding and param names. */
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Valid parallel branch keys (they appear in node paths and result objects). */
export const BRANCH_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Node paths identify static positions in a flow tree, e.g.
// "$.steps[1].branches.security.reduce" or "$.cases[0].then". Dynamic
// multiplicity (map items, loop iterations) is expressed by instance suffixes
// in run events, not here.

export function stepPath(parent: string, index: number): string {
  return `${parent}.steps[${index}]`;
}

export function branchPath(parent: string, key: string): string {
  return `${parent}.branches.${key}`;
}

export function bodyPath(parent: string): string {
  return `${parent}.body`;
}

export function reducePath(parent: string): string {
  return `${parent}.reduce`;
}

export function casePath(parent: string, index: number): string {
  return `${parent}.cases[${index}].then`;
}

export function elsePath(parent: string): string {
  return `${parent}.else`;
}
