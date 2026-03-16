import type {
  FlowSpec,
  ForkFlowSpec,
  JoinFlowSpec,
  LoopFlowSpec,
  SequenceFlowSpec,
  SpawnFlowSpec,
} from "./types.js";

/**
 * Options for Mermaid diagram generation.
 */
export interface MermaidOptions {
  /** Graph direction: top-down or left-right. Defaults to "TD". */
  direction?: "TD" | "LR";
  /** Optional title rendered as Mermaid frontmatter. */
  title?: string;
}

/**
 * Entry and exit node IDs for a flow fragment.
 *
 * `null` means the fragment has no connectable endpoint on that side:
 * - A fork has no single exit (branches fan out to a later join).
 * - A join has no single entry (it collects from fork branches).
 */
interface Endpoints {
  entry: string | null;
  exit: string | null;
}

interface Context {
  counter: number;
  defs: string[];
  edges: string[];
  nodeClasses: Map<string, string>;
  forkBranchExits: Map<string, Array<{ key: string; exitId: string }>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextId(ctx: Context): string {
  const id = `n${ctx.counter}`;
  ctx.counter += 1;
  return id;
}

function esc(text: string): string {
  return text.replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Visitors — one per FlowSpec variant
// ---------------------------------------------------------------------------

function visitSpawn(spec: SpawnFlowSpec, ctx: Context): Endpoints {
  const id = nextId(ctx);
  const label = spec.label ?? spec.agent;
  ctx.defs.push(`  ${id}(["${esc(label)}"])`);
  ctx.nodeClasses.set(id, "spawn");
  return { entry: id, exit: id };
}

function visitSequence(spec: SequenceFlowSpec, ctx: Context): Endpoints {
  if (spec.steps.length === 0) {
    const id = nextId(ctx);
    ctx.defs.push(`  ${id}["empty"]`);
    return { entry: id, exit: id };
  }

  const eps = spec.steps.map((step) => visitFlow(step, ctx));

  // Wire adjacent steps, skipping null endpoints (fork→join pairs handle
  // their own edges via the forkBranchExits map).
  for (let i = 0; i < eps.length - 1; i++) {
    const from = eps[i]?.exit;
    const to = eps[i + 1]?.entry;
    if (from != null && to != null) {
      ctx.edges.push(`  ${from} --> ${to}`);
    }
  }

  // The sequence's entry is the first non-null entry; its exit is the last
  // non-null exit. This lets a sequence starting with a fork or ending with
  // a join still expose connectable endpoints to its parent.
  const entry = eps.find((ep) => ep.entry !== null)?.entry ?? null;
  const exit = [...eps].reverse().find((ep) => ep.exit !== null)?.exit ?? null;
  return { entry, exit };
}

function visitFork(spec: ForkFlowSpec, ctx: Context): Endpoints {
  const id = nextId(ctx);
  const label = spec.label ?? spec.id;
  ctx.defs.push(`  ${id}{"${esc(label)}"}`);
  ctx.nodeClasses.set(id, "fork");

  const branchExits: Array<{ key: string; exitId: string }> = [];

  // Sort branch keys for deterministic output.
  const sortedKeys = Object.keys(spec.branches).sort();
  for (const key of sortedKeys) {
    const branchSpec = spec.branches[key];
    if (!branchSpec) continue;
    const ep = visitFlow(branchSpec, ctx);
    if (ep.entry !== null) {
      ctx.edges.push(`  ${id} -->|"${esc(key)}"| ${ep.entry}`);
    }
    if (ep.exit !== null) {
      branchExits.push({ key, exitId: ep.exit });
    }
  }

  ctx.forkBranchExits.set(spec.id, branchExits);

  // Fork fans out — it has no single exit. The corresponding join will
  // collect branch exits and provide the converging exit point.
  return { entry: id, exit: null };
}

function visitJoin(spec: JoinFlowSpec, ctx: Context): Endpoints {
  const id = nextId(ctx);
  const modeLabel =
    spec.mode === "quorum"
      ? `join: quorum(${spec.quorum})`
      : `join: ${spec.mode}`;
  const label = spec.label ?? modeLabel;
  ctx.defs.push(`  ${id}{"${esc(label)}"}`);
  ctx.nodeClasses.set(id, "join");

  // Draw edges from every branch exit of the referenced fork.
  const branchExits = ctx.forkBranchExits.get(spec.from);
  if (branchExits) {
    for (const { exitId } of branchExits) {
      ctx.edges.push(`  ${exitId} --> ${id}`);
    }
  }

  // Join has no "entry" from the sequence perspective — incoming edges come
  // from the fork's branches, not from the preceding sequence step.
  return { entry: null, exit: id };
}

function visitLoop(spec: LoopFlowSpec, ctx: Context): Endpoints {
  const id = nextId(ctx);
  const label = spec.label ?? spec.id;
  ctx.defs.push(`  ${id}{{"${esc(label)}"}}`);
  ctx.nodeClasses.set(id, "loop");

  const bodyEp = visitFlow(spec.body, ctx);
  if (bodyEp.entry !== null) {
    ctx.edges.push(`  ${id} --> ${bodyEp.entry}`);
  }
  if (bodyEp.exit !== null) {
    ctx.edges.push(`  ${bodyEp.exit} -.->|"repeat"| ${id}`);
  }

  // The loop node is both entry and exit: incoming edges reach the loop
  // control node, and after the loop finishes the next step connects from it.
  return { entry: id, exit: id };
}

function visitFlow(spec: FlowSpec, ctx: Context): Endpoints {
  switch (spec.kind) {
    case "spawn":
      return visitSpawn(spec, ctx);
    case "sequence":
      return visitSequence(spec, ctx);
    case "fork":
      return visitFork(spec, ctx);
    case "join":
      return visitJoin(spec, ctx);
    case "loop":
      return visitLoop(spec, ctx);
  }
}

// ---------------------------------------------------------------------------
// Style definitions — one per node kind
// ---------------------------------------------------------------------------

const CLASS_STYLES: Record<string, string> = {
  spawn: "fill:#e1f5fe,stroke:#0288d1,color:#01579b",
  fork: "fill:#fff3e0,stroke:#f57c00,color:#e65100",
  join: "fill:#e8f5e9,stroke:#388e3c,color:#1b5e20",
  loop: "fill:#f3e5f5,stroke:#7b1fa2,color:#4a148c",
};

/** Fixed order so the output is deterministic regardless of Map iteration. */
const CLASS_ORDER = ["spawn", "fork", "join", "loop"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a {@link FlowSpec} into a deterministic Mermaid flowchart string.
 *
 * The same input always produces the same output:
 * - Node IDs are counter-based (`n0`, `n1`, …) assigned in depth-first order.
 * - Fork branches are visited in sorted key order.
 * - Class definitions and assignments follow a fixed order.
 *
 * Node shapes encode the flow kind:
 * - **spawn** → stadium `(["…"])`
 * - **fork** → diamond `{"…"}`
 * - **join** → diamond `{"…"}`
 * - **loop** → hexagon `{{"…"}}`
 *
 * @example
 * ```ts
 * const diagram = toMermaid(flow, { title: "My Workflow" });
 * console.log(diagram);
 * ```
 */
export function toMermaid(flow: FlowSpec, options?: MermaidOptions): string {
  const direction = options?.direction ?? "TD";
  const ctx: Context = {
    counter: 0,
    defs: [],
    edges: [],
    nodeClasses: new Map(),
    forkBranchExits: new Map(),
  };

  visitFlow(flow, ctx);

  // --- assemble output -------------------------------------------------------

  const output: string[] = [];

  if (options?.title) {
    output.push("---");
    output.push(`title: ${options.title}`);
    output.push("---");
  }

  output.push(`flowchart ${direction}`);
  output.push(...ctx.defs);
  output.push(...ctx.edges);

  // Collect class groups.
  const classGroups = new Map<string, string[]>();
  for (const [id, cls] of ctx.nodeClasses) {
    let group = classGroups.get(cls);
    if (!group) {
      group = [];
      classGroups.set(cls, group);
    }
    group.push(id);
  }

  const usedClasses = CLASS_ORDER.filter((cls) => classGroups.has(cls));
  if (usedClasses.length > 0) {
    for (const cls of usedClasses) {
      output.push(`  classDef ${cls} ${CLASS_STYLES[cls]}`);
    }
    for (const cls of usedClasses) {
      const ids = classGroups.get(cls)?.sort() ?? [];
      output.push(`  class ${ids.join(",")} ${cls}`);
    }
  }

  return output.join("\n");
}
