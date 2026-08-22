# Revised structural change plan

Goals unchanged: presentation must never block execution, validation must be
one contract, results must be predictable, and the model-facing surface should
get simpler — but only where evidence supports it and without losing the
algebra's core capabilities (data flow, structured results, fan-out/merge).

The plan is now sequenced. Phases 1–3 are committed work. Phase 4 is gated on
telemetry and a completed design spec.

## Stable architecture

The revised design uses one operation at the trigger boundary and keeps its
internal stages separate. A single large launch function would centralize
control but couple Pi session state, catalog I/O, validation, persistence, and
execution. The stable boundary is therefore one public operation backed by
three focused stages:

```text
surface parser
  -> launchTriggeredRun
       -> prepareLaunch
       -> RunManager.start
  -> surface formatter
```

- `prepareLaunch` applies request policy: trust and scope, saved-workflow
  resolution, flow and budget validation, and recoverable presentation
  normalization. It returns a `LaunchPlan`.
- `launchTriggeredRun` is the only fresh-run entry for tool, command, hook,
  and RPC adapters. It adds active Pi session defaults, model resolution,
  persistence, notifications, and background behavior. It passes the complete
  plan to the manager instead of exposing a field-mapping protocol to each
  trigger.
- `RunManager.start` owns execution preflight and remains a defensive boundary
  for internal and programmatic callers. It resolves profiles, skills, models,
  and tools through `resolveInvocation` before the interpreter runs.
- `rerunTriggeredRun` is a separate operation for persisted run headers. A
  persisted flow is already expanded, so reparsing it as author input would
  reject derived workflow fields.

The source tree has these dependency roles:

- `model/`: Pure flow algebra, validation, interpolation, and predicates. It
  has no I/O, discovery, or presentation policy.
- `catalog/`: Resource parsing and discovery. Catalog rendering may receive an
  availability function, but it does not define runtime executability.
- `presentation/`: Pi-independent presentation policy and model-prompt
  rendering. `result.ts` owns labels, display paths, the `report` convention,
  and result fallback order.
- `run/`: Execution, invocation resolution, budgets, persistence, and state.
  It has no TUI dependency.
- `triggers/`: Pi entry adapters. Catalog reads for command registration, hook
  routing, listings, and previews are queries rather than launch resolution.
- `ui/`: TUI components. UI code consumes run state and presentation policy.
- `engine/`: The subprocess boundary.

The architecture preserves these invariants:

1. Fresh runs from every trigger call `launchTriggeredRun` exactly once.
2. Only `triggers/start.ts` may call `prepareLaunch` or `RunManager.start` for
   a fresh trigger request.
3. `prepareLaunch` is the only request-policy implementation.
4. `resolveInvocation` is the only definition of whether an agent invocation
   can run. Prompt-time profile availability uses it too.
5. Recoverable request warnings are persisted in `RunHeader` and remain
   visible through run inspection after the initiating response is gone.
6. `model/`, `catalog/`, and `run/` never import from `ui/`.
7. Presentation selection can warn but never change execution control flow.

`tests/architecture.test.ts` enforces the import and entry-point rules. Contract
tests cover warning persistence and prompt/runtime availability agreement.

## Phase 1: Reclassify presentation errors

Invalid request-time `display` and `label` values now produce warnings instead
of launch errors. `prepareLaunch` normalizes both through
`presentation/result.ts`, and `run_created` persists the warnings in the run
header. Saved-workflow definitions still validate `display` strictly because a
bad definition should produce a catalog diagnostic before selection.

Fatal request problems remain fatal: invalid flows, resources, budgets,
scopes, and permissions stop the launch before a run ID is allocated.

## Phase 2: One trigger launch operation

Every fresh trigger path now reduces to:

```text
parse surface input -> launchTriggeredRun -> format surface output
```

The preparation stage remains directly testable, while the trigger operation
owns the transition from a plan to a started run. This avoids both earlier
failure modes: duplicated request policy in every trigger and a public
prepare-then-start protocol whose fields could drift.

Error completeness remains complete at the top level and best effort within a
malformed node. Resource preflight stays in `RunManager` because it needs the
active model registry and the catalog cache shared with execution. The trigger
operation still exposes one failure boundary to callers.

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

Model-facing calls do not accept `display`; they use the `report` convention.
Programmatic launch requests may still set `display`, and saved workflows may
pin it in their definitions.

### 3b. Best-effort executable catalog

Advertise only profiles that pass `resolveInvocation` in the rendered
`cwd`/`scope`; list unusable profiles separately with the runtime reason. The
extension composition root injects this check into prompt rendering, so neither
the presentation nor catalog layer defines executability.

The rendered appendix is cached by session context and available model set,
then cleared on session start. Runtime launch still reevaluates authentication,
resources, node-level cwd and scope overrides, and trust. Prompt availability
reduces stale choices but never replaces runtime validation.

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
5. **Profiles and placement.** Agent entries keep `profile` (a name from
   `<agents>`), `cwd`, and `scope`. Omitting `profile` creates an anonymous
   agent.
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

Single agent (`"run": "agent"`, one agent entry with `task`, `profile`,
`model`, `thinking`, `skills`, `tools`, `json`, `cwd`, `scope`) and saved workflow
(`"run": "workflow"`, `name` + `params`) follow the same envelope. Sequential
groups use `"mode": "sequence"` with `{previous}`/`{<id>}` references.

The simplified API **compiles into the existing algebra** (`agent`,
`parallel` + `reduce`, `sequence` with `as` bindings). The algebra remains the
internal and programmatic representation; saved workflows keep the full
grammar.

## Phase 5: Replacement

- Saved-workflow format and the programmatic `flow` type remain unchanged.
- Model-facing raw `flow` stays until Gates A and B pass and the replacement
  covers the observed common cases. The replacement then removes `flow` from
  the tool schema in one breaking change while the programmatic API keeps it.
- Prompt material changes in the same commit as the tool schema. The algebra
  lives in the tool description (`FLOW_REFERENCE`), the use gate (`USE_GATE`),
  and the `promptGuidelines` that `tool.ts` requires to stay in sync.
- Model-facing calls do not accept `display`. Saved workflows keep `display`.

## What changed from the previous draft

- The launch boundary is one trigger operation with separate preparation and
  execution stages, not one module that owns unrelated dependencies.
- `presentation/` now owns Pi-independent result and metadata policy. This
  keeps `model/`, `catalog/`, and `run/` independent of the TUI layer.
- Recoverable warnings are persisted with run state instead of existing only
  in the initiating tool or RPC response.
- Prompt-time profile availability uses `resolveInvocation`, so prompt and
  runtime checks cannot acquire different rules.
- The drift check enforces the actual seam: trigger files cannot prepare or
  start fresh runs outside `triggers/start.ts`.
- Error completeness is promised only at the top level.
- Catalog availability remains best effort because resources can change after
  prompt rendering; runtime errors remain authoritative.
- The simplified API is gated on telemetry and now specifies data flow,
  `json`, merge, concurrency, profiles, and a discriminated envelope — the
  previous draft could not express fan-out-and-merge and left sequence data
  flow undefined.
- `map` is explicitly excluded with its workaround documented, rather than
  silently dropped.
- Prompt material changes atomically with any model-facing schema replacement.
