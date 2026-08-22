# Revised structural change plan

Goals unchanged: presentation must never block execution, validation must be
one contract, results must be predictable, and the model-facing surface should
get simpler — but only where evidence supports it and without losing the
algebra's core capabilities (data flow, structured results, fan-out/merge).

The plan is now sequenced. Phases 1–3 are committed work. Phase 4 is gated on
telemetry and a completed design spec.

## Architectural baseline

The layering is already mostly right, and the plan builds on it rather than
replacing it:

- `model/` — pure flow algebra: AST, validation, interpolation, predicates.
  No I/O, no UI, no discovery.
- `catalog/` — the only discovery layer: agents, skills, workflows, models,
  scoped by trust.
- `run/` — execution: `invocation.ts` is already "the one place" that
  resolves what an agent runs with; `interpreter.ts`/`runner.ts` execute;
  `persist.ts` records. `triggers/start.ts` is the shared run-start path.
- `triggers/` — entry surfaces (tool, commands, hooks, RPC). Should contain
  surface I/O and formatting only.
- `ui/` — presentation. Consumes results; never influences control flow.
- `engine/` — the subprocess boundary.

**The structural gap:** there is no launch layer. Each of the four trigger
surfaces hand-assembles the same pipeline — trust/scope clamp →
`discoverWorkflows` → `resolveWorkflowByName` → `validateFlow` →
`normalizeDisplayPath` → `startTriggeredRun` — in slightly different orders
with slightly different rules (`tool.ts:376-399`, `rpc.ts:174-206`,
`hooks.ts:147-165`, `commands.ts:1444-1490`). Every inconsistency this plan
addresses is a symptom of that missing module, not of any one surface.

**One misplacement:** `normalizeDisplayPath` lives in `model/ast.ts`, so the
pure model layer throws on a presentation concern. That layering violation is
why the original display bug was possible at all.

Invariants this plan establishes (and that later work must preserve):

1. Triggers parse surface input and format surface output; they do not
   discover, resolve, or validate.
2. `model/` stays pure and knows nothing about presentation.
3. `catalog/` is the only module that discovers; `run/invocation.ts` is the
   only module that resolves.
4. Presentation concerns (`display`, `report`, labels) live in `ui/` and the
   launch layer, and can warn but never abort.
5. New entry surfaces call the launch contract; they never reassemble the
   pipeline.

A cheap drift check lives in the test suite (`tests/architecture.test.ts`):
`validateFlow` or `normalizeDisplayPath` used anywhere under `src/triggers/`
is a regression — execution validation goes through the launch layer.
Catalog reads for routing or listing (hook event filtering, `/workflows`
listings) remain legitimate in triggers.

## Phase 1: Reclassify presentation errors (ship immediately)

**Problem:** `normalizeDisplayPath` throws at request time
(`src/model/ast.ts`, called from the tool and `src/triggers/rpc.ts`), so an
invalid `display` aborts an otherwise valid run. Render time already does the
right thing: `src/ui/render.ts` falls back to the complete result with a
warning when the path is missing or non-string.

**Change:**

- Invalid `display` and invalid `label` become warnings attached to the run,
  never launch errors. The run starts; presentation falls back to the complete
  result.
- Fatal remains fatal: invalid tasks, flows, resources, budgets, scopes, and
  permissions abort with node-path errors as today.
- Missing optional values use documented defaults.

- Relocate display-path handling out of `model/ast.ts` — the model layer must
  not carry presentation logic (invariant 2). Its new home is the launch
  layer introduced in Phase 2; as an interim step it may move to `ui/` next to
  the existing fallback in `render.ts`.

This is deliberately the previously discarded "provisional display patch,"
reframed as the first instance of the fatal/recoverable classification rather
than a one-off. It fixes the original bug in one small change and nothing in
later phases depends on delaying it.

## Phase 2: One launch contract

**Problem:** The typebox schema, `validateFlow`, and resource preflight
enforce different rules at different times across `tool.ts`, `rpc.ts`,
`hooks.ts`, and `api.ts`.

**Change:** Introduce the missing launch layer — one module (e.g.
`src/run/launch.ts`) that owns the request pipeline end to end: trust/scope
clamping, workflow discovery and resolution, flow validation, budget checks,
and presentation normalization. Every entry point (tool, commands, hooks,
RPC, extension API) reduces to: parse surface input → call the contract →
format surface output. It produces either:

- a validated launch plan, or
- actionable errors plus recoverable warnings (per the Phase 1
  classification).

Error completeness is scoped honestly: **complete at the top level,
best-effort within nodes.** A malformed parent node reports one error at its
node path without cascading synthetic errors from children that were never
meaningfully parseable.

This phase is a refactor with no intended behavior change beyond error/warning
uniformity. It is also the architectural payoff of the plan: after it, the
four trigger surfaces stop importing `validateFlow`/`discoverWorkflows`
directly (enforced by the drift check), the contract is testable in one place,
and Phase 4's telemetry has a single choke point to instrument.

## Phase 3: Predictable results and an honest catalog

### 3a. `report` result convention

Replace caller-supplied `display` as the *default* mechanism:

- String results are presented directly.
- Structured results are preserved in full for machine consumers.
- If a structured result contains a top-level `report` string, the UI renders
  it as Markdown.
- Without `report` — or when `report` exists but is not a string — the UI
  renders the complete structured result. `report` is a **soft convention**,
  not a reserved key: a non-Markdown `report` field degrades to the full-result
  fallback, never to an error.

Ownership of `report` must be explicit per shape:

- Single agent: the agent's `json` schema may include `report`.
- Parallel work: the **reduce/merge step** owns `report`. This is why merge
  cannot be dropped from any future simplified API (see Phase 4).
- Saved workflows: definitions keep `display` (they are validated ahead of
  use and may know their result shape). `display` on a saved workflow
  overrides the `report` convention.

`display` on model-facing calls is deprecated but accepted (warning, Phase 1
semantics) until Phase 4 resolves the tool surface.

### 3b. Best-effort executable catalog

Advertise only profiles whose skills, models, and dependencies resolve in the
rendered scope; list unusable profiles separately with a reason.

Scoped honestly: the catalog is rendered into the system prompt once per
session, while auth, skill availability, and trust-clamped scope
(`effectiveScope`) are evaluated per request with per-request `cwd`/`scope`.
This is **staleness reduction, not a guarantee.** Runtime errors for
unavailable resources stay, and stay actionable, regardless.

## Phase 4: Simplified model-facing API (gated)

**Premise to verify first:** "models regularly produce malformed flow trees."
This is currently asserted, not measured. PR #58 already fixed the largest
observed failure (stringified flows), and `validateFlow` returns node-path
errors that models retry against.

### Gate A: telemetry

Instrument the launch contract (Phase 2 makes this one choke point):

- malformed-flow rate per model,
- error category (schema shape, unknown resource, bad reference, other),
- retry success rate after a node-path error.

Proceed only if malformed rates remain material after Phases 1–3.

### Gate B: design spec

The earlier draft could not express its own flagship use case (fan out, then
merge) and left data flow undefined. Before implementation, the simplified API
must specify:

1. **Data flow.** The algebra's core rule is "nothing flows implicitly." The
   simplified API keeps that rule explicit but cheap: in a `sequence`, each
   task may reference `{previous}` and `{<id>}` of earlier steps; in a
   `parallel` group, the merge task references `{<id>}` per branch. No other
   flow exists.
2. **Structured results.** Each agent keeps optional `json`. Without it,
   the `report` convention and structured handoff both collapse.
3. **Merge.** `group` supports an optional `merge` step (task + the usual
   execution options) that receives all branch results. "Fan out, merge
   findings" is the common case, not an advanced one.
4. **Concurrency.** `group` takes an optional `concurrency`. Dynamic `map`
   is intentionally excluded: the calling model expands lists into static
   agents itself; document this explicitly.
5. **Profiles and placement.** Agent entries keep `name` (profile from
   `<agents>`), `cwd`, and `scope`. Dropping profile selection would be a
   regression, not a simplification.
6. **Discriminated union.** The request carries an explicit discriminant
   (e.g. `"run": "agent" | "group" | "workflow"`) rather than mutually
   exclusive optional keys — otherwise the top level reintroduces the exact
   undiscriminated-oneOf fragility the phase exists to remove.
7. **Uniqueness.** Branch/step `id`s are validated unique; they exist to key
   results and references, in both `sequence` and `group`.

### Sketch (revised)

```json
{
  "run": "group",
  "mode": "parallel",
  "concurrency": 2,
  "agents": [
    { "id": "correctness", "task": "Review for correctness",
      "json": { "type": "object", "properties": { "findings": { "type": "array" } },
                 "required": ["findings"], "additionalProperties": false } },
    { "id": "tests", "task": "Review test coverage" }
  ],
  "merge": {
    "task": "Merge {correctness} and {tests} into one report",
    "json": { "type": "object",
              "properties": { "report": { "type": "string" } },
              "required": ["report"], "additionalProperties": true }
  },
  "label": "Review change",
  "budgets": { "maxDuration": 600 }
}
```

Single agent (`"run": "agent"`, one agent entry with `task`, `name`, `model`,
`thinking`, `skills`, `tools`, `json`, `cwd`, `scope`) and saved workflow
(`"run": "workflow"`, `name` + `params`) follow the same envelope. Sequential
groups use `"mode": "sequence"` with `{previous}`/`{<id>}` references.

The simplified API **compiles into the existing algebra** (`agent`,
`parallel` + `reduce`, `sequence` with `as` bindings). The algebra remains the
internal and programmatic representation; saved workflows keep the full
grammar.

## Phase 5: Migration

- Saved-workflow format and the programmatic `flow` type are preserved
  unchanged throughout.
- Model-facing raw `flow` stays accepted (with `coerceInlineFlow`) until Gate
  A/B pass and the simplified API demonstrably covers the observed common
  cases; then it is deprecated with a warning, then removed from the tool
  schema (while remaining in the programmatic API).
- **Prompt material is a first-class migration surface.** The algebra lives in
  the tool description (`FLOW_REFERENCE`), the use gate (`USE_GATE`), and the
  promptGuidelines that `tool.ts` requires be kept in sync. The Phase 4
  rollout includes rewriting all three together, since model-behavior
  regressions will originate there, not in the schema.
- `display` on model-facing calls: warn in Phase 3, remove with the Phase 4
  tool schema. Saved workflows keep `display` permanently.

## What changed from the previous draft

- An explicit architectural baseline: named layers, five invariants, the
  missing launch module identified as the root cause of the per-surface
  drift, and a mechanical drift check. No new abstraction beyond that one
  module — the existing `model`/`catalog`/`run`/`triggers`/`ui` split is
  kept as is.
- Phase 1 also relocates display handling out of `model/ast.ts`, fixing the
  layering violation that produced the original bug.
- Phase 2 is reframed from "error uniformity" to "introduce the launch
  layer"; uniform errors fall out of it.

- The display patch is Phase 1, not discarded — it was the fatal/recoverable
  classification in miniature.
- Error completeness is promised only at the top level.
- The catalog change is labeled best-effort; runtime errors remain.
- The simplified API is gated on telemetry and now specifies data flow,
  `json`, merge, concurrency, profiles, and a discriminated envelope — the
  previous draft could not express fan-out-and-merge and left sequence data
  flow undefined.
- `map` is explicitly excluded with its workaround documented, rather than
  silently dropped.
- Prompt-material migration is called out as its own work item.
