# 🤖 pi-agents

Multi-agent workflows for
[pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent).

Built on an explicit algebra: every workflow is an expression tree in which
every node yields a value, and data flows only through references you write
down. No hidden context injection, no id-based cross-wiring — any subtree is
itself a valid workflow.

## 🚀 Installation

```sh
pi install npm:pi-agents
```

Zero configuration required. The package includes `/review` for read-only code
review and `/review-fix` for iterative review and repair. Right after installing,
the model can also delegate and compose work with anonymous **ad-hoc agents** —
no agent files needed:

```json
{
  "flow": {
    "kind": "parallel",
    "branches": {
      "bugs":    { "kind": "agent", "task": "Review src/run for bugs" },
      "clarity": { "kind": "agent", "task": "Review src/run for clarity" }
    },
    "reduce": { "task": "Merge and prioritize:\n{branches}" }
  }
}
```

An agent node without a `name` spawns a generic delegated pi process: the
active session's model and thinking level (unless the node overrides them),
the normal pi system prompt, and the default tool set. Named agent files are
optional reusable personas layered on top.

Delegated agents use the `pi` executable on `PATH` through Pi's current RPC
protocol. pi-agents intentionally follows the latest Pi release instead of
pinning or maintaining a legacy execution fallback, so keep Pi up to date.

The originating Pi process owns workflow orchestration. A delegated process is
a terminal workflow leaf: pi-agents does not register its tools, commands,
hooks, RPC endpoint, catalogs, run manager, or UI there. The parent interpreter
expands the complete static graph before execution, so saved `workflow` nodes
still compose normally and every agent remains part of the originating run's
budget, history, and progress display. Put any fan-out, reduction, iteration,
or saved-workflow composition in the parent flow rather than asking a child
agent to start another workflow.

## 📖 Concepts

Three nouns carry the whole framework:

| Concept      | What it is                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **agent**    | A delegated pi subprocess: anonymous (ad-hoc, just a task) or a reusable persona defined in a markdown file (`.pi/agents/*.md`). |
| **workflow** | A saved, named composition of agents (`.pi/workflows/*.yaml`) — or an inline expression.           |
| **run**      | One persisted execution of a workflow. Browse with `/workflows`, inspect with `/workflow <id>`.  |

### The algebra

A workflow is a tree of nine node kinds. Composition is purely structural:
`parallel` fuses fork and join into one expression, iterative nodes are bounded,
and saved workflows inline like function calls.

| Icon | Node       | Meaning                                                   | Value                                      |
| :--: | ---------- | --------------------------------------------------------- | ------------------------------------------ |
| `✦`  | `agent`    | Run one delegated agent on a task (the only leaf).        | Its explicitly submitted result.          |
| `≡`  | `sequence` | Run steps in order.                                       | The last step's value.                     |
| `⑃`  | `parallel` | Run named branches concurrently, optionally `⑂` reduce.   | `{branch: value}`, or the reducer's value. |
| `⇶`  | `map`      | Fan out a body per element of a runtime array.            | Array of body values, or the reducer's.    |
| `↺`  | `loop`     | Run a body, then repeat until a predicate holds.          | The last iteration's value.                |
| `↺`  | `while`    | Carry a value through a body while a predicate holds.     | The final carried value.                   |
| `⎇`  | `switch`   | Route to the first arm whose predicate matches a value.   | The chosen arm's value.                    |
| `≔`  | `value`    | Yield a template-interpolated JSON value (no agent).      | The interpolated value.                    |
| `❖`  | `workflow` | Invoke a saved workflow by name (inlined, cycle-checked). | The inlined flow's value.                  |

The JSON/YAML form is what you author; the icons are how flows are *read*.
Every surface that shows a flow — the tool call display, `/workflow <name>`,
`/workflow <run-id>` — renders it as an icon tree. A named workflow is the
visual root of its steps; a titleless inline flow remains flat. This
repository's `review-fix` workflow has the following shape (abridged):

```
❖ review-fix
├─ ❖ review → {initial_review}
├─ ⎇ switch {initial_review} → {initial_state}
├─ ↺ while outcome == "changes_required" on {initial_state} ≤3 → {cycle_result}
│  ├─ ✦ ad-hoc → {implementation}
│  ├─ ❖ review → {verified_review}
│  └─ ⎇ switch {verified_review}
└─ ⎇ switch {cycle_result}
   └─ changes remain → ≔ exhausted
```

Sequences are transparent — their steps appear at the parent level without
extra nesting. When inspecting a run, the kind icons are replaced by live
status icons (`○` pending, `◉` running, `●` completed, `✗` failed,
`⊘` cancelled, `⊖` skipped), with dynamic fan-out aggregated in place:

```
● scout → {files} · List files to review
◉ ad-hoc · Review {item} [3/5]
○ reduce → synthesizer · Merge {items}
```

### Explicit data flow

Nothing flows between nodes implicitly. To pass data:

- Mark a `sequence` step with `as: name`, then reference `{name}` (or a dot path
  like `{name.files.0}`) in any later step of that sequence.
- `{previous}` is the immediately preceding step's value.
- A `map` body sees `{item}` and `{index}`. A `loop` body sees `{iteration}`
  and `{last}` (empty on the first iteration); a `while` body sees
  `{iteration}` and `{current}`. Nested iterative nodes expose only their own
  control roots, while enclosing map roots remain visible.
- Reduce tasks see `{branches}` (parallel) or `{items}` (map).
- Saved workflows see only their declared `{params.*}` — caller bindings are
  invisible, and param values are interpolated in the caller's scope.

Unknown references are validation errors with node paths, caught before
anything spawns. Declare a `json` schema on an upstream agent when downstream
steps need dot-path access or predicates. Escape literal braces as `{{`/`}}`.

## ⚡ Quick start

### 1. (Optional) Define an agent profile

Agent files exist for *reuse*: a persona plus the defaults you want applied
consistently across flows. Every one of those defaults — skills, tools, model,
thinking — is also available per call, so a profile is worth writing only for
the persona and the repetition. For a one-off delegation, omit `name` and
configure the node directly.

`.pi/agents/planner.md`:

```md
---
name: planner
description: Maps a codebase and proposes implementation plans
model: openai-codex/gpt-5.6-terra  # optional; defaults to the active session model
thinking: medium           # optional: off|minimal|low|medium|high|xhigh
skills: []                 # closed skill set for this profile
tools: [read, grep, find]  # optional working-tool allowlist; [] means none
---

You are a planning agent. Map the relevant code and return a concrete plan with
file paths. Do not edit files.
```

Agents are discovered from `~/.pi/agent/agents` (user) and `<project>/.pi/agents`
(project); project wins on name conflicts. The project is the nearest ancestor
of the cwd holding a `.pi` directory, and *all* project resources come from that
one root — profiles, skills, and workflows alike — so a nested `.pi` shadows an
outer one completely. An agent is purely a persona — the *who*. The *what* (a
task) always comes from the flow that references it; for a named, reusable
agent+task unit, use a flat workflow (below).

### 2. Define a workflow

Workflows are pure data: one YAML or JSON object per file, and the extension
decides the parser (`.yaml`, `.yml`, `.json`). A reusable agent-plus-task unit
uses the flat form. For example, this repository's project-local
`.pi/workflows/review.yaml` starts an anonymous reviewer without requiring a
named profile:

```yaml
name: review
description: Review a target with structured findings
trigger: when the user asks for a read-only code review
display: report
params:
  - { name: target, required: true }
  - { name: focus, default: "Apply normal risk-based lens selection." }
  - { name: context, default: "No prior round context." }
task: |-
  Review {params.target}.
  Focus: {params.focus}
  Context: {params.context}
  Keep outcome and report semantically consistent.
json:
  type: object
  required: [outcome, report]
  properties:
    outcome: { enum: [approved, changes_required, cannot_proceed] }
    report: { type: string, minLength: 1 }
  additionalProperties: false
thinking: high
tools: [read, bash]
```

The flat form normalizes to a bare agent leaf while retaining workflow powers:
parameters, a slash command, event hooks, and composition through a `workflow`
node. `agent:` is optional; omitting it runs an ad-hoc agent. The flat form
accepts every agent-node option (`model`, `thinking`, `skills`, `tools`, `cwd`,
`scope`, `json`). Mixing the flat form with `flow:` is an error; put execution
options on the relevant agent node when `flow:` is present.

When a workflow returns structured data with a human-readable Markdown field,
set `display` to its dot path. A top-level run renders that string in completion
cards and run details while preserving the complete structured value for the
calling model, `/workflow <id> raw`, and parent workflows. A nested workflow
always passes its complete value to its caller. If the path is missing or does
not resolve to a string, rendering falls back to the raw value.

Saved workflows compose like functions through `workflow` nodes. The bundled
`/review-fix` workflow uses that composition to invoke `/review`, then sends
validated P1–P3 findings to an anonymous
Implementer, and ends every implementation round with a fresh review. It stops
when the change is approved, cannot proceed, or reaches three complete
implementation-and-review rounds. The review rubric is part of the workflow,
so neither command requires an external agent profile or skill. Its Markdown
report keeps fixed emoji-coded severity and category headings plus a verdict
table for quick scanning, while the accompanying JSON fields remain plain for
machine consumers. Both workflows declare `display: report`, so people see the
Markdown review instead of the JSON routing contract.
The reviewer allowlist removes Pi's direct editing tools as an
accident-reduction measure. It is not a read-only sandbox: `bash` can still
modify the checkout, so the review contract also explicitly prohibits writes.
The maximum run executes seven agents: one initial Reviewer and three
Implementer/Reviewer pairs. Its flat final result includes `outcome`, `reason`,
`round_index`, `report`, `actionable`, and `implementation`; `outcome` is
`approved`, `cannot_proceed`, or `exhausted`. Implementer messages remain
Markdown because only reviewer output controls routing: forcing strict JSON
there would turn a malformed status report into a mid-cycle hard failure.

These two workflow files are also shipped unchanged in the npm package as
bundled defaults. A workflow with the same name in
`~/.pi/agent/workflows` or `.pi/workflows` overrides its bundled definition.
Every definition is fully validated at discovery (references, cycles, binding
scopes); invalid files are listed in `/workflows` diagnostics and never run.

You can disable every bundled workflow globally in
`~/.pi/agent/workflows.json`:

```json
{
  "bundledWorkflows": false
}
```

Set individual names to control them separately; unspecified names inherit the
current default:

```json
{
  "bundledWorkflows": {
    "review": true,
    "review-fix": false
  }
}
```

A trusted project can put the same setting in `.pi/workflows.json`. Project
settings layer over user settings, so an object can selectively re-enable a
workflow after a global `false`. A scalar `true` or `false` resets the setting
for every bundled workflow at that scope. Omit `bundledWorkflows` or set it to
`true` to enable all bundled defaults.

The bundled `review-fix` workflow invokes `review`. If no user or project
workflow overrides `review`, disabling bundled `review` also disables bundled
`review-fix` and reports the dependency in `/workflows` diagnostics.

### 3. Trigger it

Workflows fire from four surfaces:

1. **The root model.** Saved workflows (name, description, `trigger`, params)
   are advertised in the system prompt; the model runs them — or composes
   ad-hoc flows — through the single `workflow` tool. The tool is
   **opt-in**: the model may only reach for it when you affirmatively ask
   for something to run — "run the review workflow", "delegate this", "do
   these in parallel" — or for a saved workflow you asked for by name or by
   its `trigger` situation. Merely saying *workflow* is not a request, and
   neither is a task that looks big or parallelizable. In interactive
   sessions runs go to the background: the widget shows live status, and the
   result arrives as a notification.
2. **You.** Every saved workflow registers a slash command. For a workflow
   named `triage`, `/triage src/core with spaces` runs it directly, passing the
   complete text after the command to its first parameter with no model
   round-trip. Remaining parameters use their defaults. Use the `workflow`
   tool or RPC when you need to supply multiple named parameters.
3. **Events.** Add `on: [turn_end]` (plus optional `debounce:` milliseconds)
   and the workflow fires on those pi events, always in the background,
   with the event payload bound as `{params.event}`. Hooks run only in the
   root pi process, never inside delegated children.
4. **Other extensions.** Co-loaded pi extensions in the root process can start,
   stop, and inspect runs over the in-process event bus. See
   [Event bus and RPC](#-event-bus-and-rpc).

## 🛠️ The `workflow` tool: ad-hoc flows from the model

The root model is a first-class workflow author, not just an invoker. The single
`workflow` tool takes either a saved workflow by name or a **complete inline
flow expression**, and its tool description embeds the full algebra — node
kinds, value semantics, binding rules, predicates — so the model can
translate a request like *"review these three modules in parallel, then fix
whatever the reviews agree on"* directly into a validated flow.

Authoring power is gated on your intent. The tool description opens with an
explicit-request gate, repeated as prompt guidelines every turn: the model
calls the tool when you affirmatively ask for something to run — delegate
this, spawn agents for these, do these in parallel — or name a saved workflow
to run. Mentioning *workflow* or *flow* does not count, nor does asking about
a saved workflow or editing one; in a repository about workflows those words
are everywhere. Everything else — a long task list, a multi-file refactor, an
audit, a research question, anything the model privately judges
parallelizable — it does itself, mentioning at most in one sentence that a
workflow could take it. That is what makes the example above run: *"review
these three modules in parallel"* is your request, not the model's inference.
The tool also only ever starts runs: a live agent is corrected with `steer`,
and an existing run is inspected or stopped with `/workflow <run-id>`.

```json
{
  "flow": {
    "kind": "sequence",
    "steps": [
      { "kind": "parallel",
        "as": "reviews",
        "branches": {
          "core": { "kind": "workflow", "name": "review", "params": { "target": "src/core" } },
          "run":  { "kind": "workflow", "name": "review", "params": { "target": "src/run" } },
          "ui":   { "kind": "workflow", "name": "review", "params": { "target": "src/ui" } }
        },
        "reduce": {
          "task": "List findings all reviews agree on:\n{branches}",
          "json": { "type": "array", "items": { "type": "string" } }
        } },
      { "kind": "agent", "task": "Fix these agreed findings: {previous}" }
    ]
  },
  "label": "review three modules, fix consensus",
  "budgets": { "maxAgents": 8 }
}
```

Everything the model needs is in context: the tool description carries the
algebra reference, and every turn's system prompt carries the discovered
agent catalog (names, descriptions, tools, default tasks) and workflow
catalog (names, `trigger` guidance, params). Inline flows go through exactly
the same validation as saved ones — unknown agents, bad references, and
scope violations come back as node-path errors the model can correct — and
a bare agent leaf is a valid flow, so single delegation is just
`workflow({flow: {kind: "agent", task: "…"}})` (add `name:` only to use a
saved profile).

When an inline flow returns structured data with a human-readable Markdown
field, set the call's top-level `display` to that field's dot path:

```json
{
  "flow": {
    "kind": "agent",
    "task": "Review the current change",
    "json": {
      "type": "object",
      "required": ["outcome", "summary"],
      "properties": {
        "outcome": { "enum": ["approved", "changes_required"] },
        "summary": { "type": "string" }
      },
      "additionalProperties": false
    }
  },
  "display": "summary"
}
```

The completion card, `/workflow <id> result`, and `/workflow <id> copy` use
the selected string. The calling model, parent workflows, interpolation,
routing, and `/workflow <id> raw` keep the complete object. A call-level
`display` also overrides a saved workflow's declared path for that run.

## 🧮 Node reference

### `agent`

```yaml
kind: agent
task: "Analyze {previous}"
name: specialist        # optional; must match a discovered agent profile
json:                   # optional; omit for a string result
  type: object          # substantive JSON Schema Draft 7 object
  required: [summary]
  properties:
    summary: { type: string }
  additionalProperties: false
model: some-model       # optional override (wins over the agent file)
thinking: low           # optional override (wins over the agent file)
skills: [my-review-guide] # optional closed set; [] disables skill discovery
tools: [read, grep]     # optional working-tool allowlist; [] means none
as: findings            # binding name; only legal on direct sequence steps
cwd: /path/override     # optional
scope: both             # profile and skill discovery: user|project|both
```

A bare `agent` node is a complete workflow — single delegation needs nothing
more. Without `name` the node runs as an anonymous ad-hoc agent (rendered as
`ad-hoc`): no profile prompt, but every execution option above still applies.

**Precedence** is uniform: flow node → agent file (named only) → active
session. Lists *replace* rather than merge. A named call uses its profile's
skills as a closed set unless the node replaces them. On an anonymous call,
omit `skills` to retain the child Pi process's normal ambient skill discovery.
Any explicit list is closed: a non-empty list injects exactly those skills,
and `skills: []` disables skill discovery. `tools` follows the same replacement
precedence, and `tools: []` leaves the agent with no working tools. Pi-agents
still supplies its mandatory result-submission tool. `workflow` and `steer` are
orchestration tools owned by the parent process, so agent and reducer
allowlists cannot name them. Express that work with `workflow`, `parallel`,
`map`, `loop`, or `while` nodes in the parent flow.

Skills are named, not inlined: `skills: [my-review-guide]` resolves against
the user and project catalogs below. In precedence order, first match wins:

| Scope   | Locations                                                            |
| ------- | -------------------------------------------------------------------- |
| project | `<project>/.pi/skills`, then `.agents/skills` from the cwd up to the git root |
| user    | `~/.pi/agent/skills`, then `~/.agents/skills`                        |

The same `scope` that governs profile discovery selects which rows apply, so an
untrusted project contributes no skills at all. Resolved instructions are
injected into the delegated agent's system prompt; a name that does not resolve
fails the run during preflight, before anything spawns.

Pi packages can bundle skills through `pi.skills`, but pi-agents does not yet
include package resources in delegated-node skill resolution. Put skills used
by workflow nodes in one of the user or project locations above.

**Value contract.** An agent completes by using the provided **Submit Agent
Result** tool exactly once. It submits one closed envelope: `{result: payload}`
for success or `{error: {reason: "..."}}` when it cannot complete the
assignment. A successful node receives only the unwrapped payload. An error
submission fails the node with the supplied reason.

Omit `json` when the payload is one complete string, including any Markdown.
For a machine-readable payload, set `json` to a substantive JSON Schema Draft
7 object. Pi validates the payload against that schema and returns rejected
submissions to the agent for correction. Arbitrary `json: true` payloads and
empty schemas are not accepted; every structured result must state its
contract.

Use the native error envelope only when the agent cannot produce a conforming
result. Keep domain outcomes that a workflow routes on, such as a review's
`cannot_proceed`, inside the result payload. Assistant messages, thinking,
working-tool calls, and tool output remain transient activity for the live
display. If the process settles without an accepted submission, the agent
fails. There is no final-message fallback or retained child transcript.

### `sequence`

```yaml
kind: sequence
steps:
  - { kind: agent, name: scout, task: "Map the code", as: map }
  - { kind: agent, name: planner, task: "Plan using {map}" }
  - { kind: agent, name: worker, task: "Implement {previous}" }
```

### `parallel`

```yaml
kind: parallel
branches:
  a: { kind: agent, name: x, task: "..." }
  b: { kind: agent, name: y, task: "..." }
mode: all               # "all" (default) | "any" | { quorum: n }
onError: fail           # "fail" (default, cancels siblings) | "collect"
concurrency: 4          # cap on simultaneous branches
reduce:                 # optional fold over the collected value
  task: "Merge {branches}"
  agent: synthesizer    # optional; omit to reduce with an ad-hoc agent
  skills: [my-review-guide] # reducers take every agent-node execution option:
  model: some-model     # model, thinking, skills, tools, cwd, scope, output
```

A reducer is an ordinary agent call whose task sees the collected value; only
the profile selector is spelled differently (`agent`, not `name`). Omitted
`cwd` and `scope` fall back to the run's.

Value: `all`/`quorum` yield `{branch: value}`; `any` yields the winner's
value and cancels the rest. With `onError: collect`, failed branches appear
as `{error: "..."}` entries and the node fails only when every branch fails.

### `map`

```yaml
kind: map
over: "{scout.files}"   # must resolve to a JSON array at runtime
body:
  kind: agent
  name: auditor
  task: "Review {item} (#{index})"
concurrency: 4
reduce: { agent: synthesizer, task: "Combine {items}" }
```

Dynamic fan-out: the body runs once per array element, results return in
input order, and any item failure cancels the rest and fails the node.

### `loop`

```yaml
kind: loop
body:
  kind: agent
  name: fixer
  task: "Iteration {iteration}; prior: {last}"
  json:
    type: object
    required: [done]
    properties: { done: { type: boolean } }
max: 3
until: { eq: ["done", true] }
```

`loop` is a bounded do-until: its body executes at least once, `{last}` is
empty for that first iteration, and `until` is evaluated against each body
result. The node returns the last result when the predicate matches or `max`
is reached. Live and completed run trees show rounds started against the
effective cap, for example `[#2/3]`.

### `while`

```yaml
kind: while
on: "{initial_state}"       # exactly one reference, resolved before the loop
condition: { eq: ["outcome", "changes_required"] }
max: 3
body:
  kind: agent
  task: "Round {iteration}; fix {current.actionable}"
  json:
    type: object
    required: [outcome, actionable]
    properties:
      outcome: { enum: [changes_required, approved] }
      actionable: { type: array }
```

`while` is a bounded, pre-checked fold. It resolves `on` once in the enclosing
scope, evaluates `condition` against that value, and runs the body only while
the predicate matches. The body sees the zero-based `{iteration}` and the
carried `{current}` value; its result becomes the next carried value. If the
initial condition is false, the node runs zero iterations and returns `on`
unchanged. If `max` is reached, it returns the current value without adding a
termination flag, so callers that distinguish convergence from exhaustion
must encode that state in the carried value. Run trees show `[#0/3]` when the
initial condition is false and otherwise update the round count as bodies
start.

Predicates address their subject's JSON value by dot path (`""` is the whole
value): `eq`, `ne`, `gt`, `lt`, `exists`, `empty`, composed with `and`, `or`,
`not`. The same language is used by `loop.until`, `while.condition`, and
`switch.cases[].when`.

### `switch`

```yaml
kind: switch
on: "{gate}"            # exactly one reference, like map's "over"
cases:
  - when: { eq: ["status", "approved"] }
    then: { kind: agent, name: shipper, task: "Ship it" }
  - when: { exists: "findings" }
    then: { kind: agent, name: fixer, task: "Fix {gate.findings}" }
else:                   # required — the switch always yields a value
  kind: value
  value: { outcome: "{gate.outcome}" }
```

Exclusive, ordered, total routing on data: `on` resolves to a JSON value,
the cases' predicates are tried in
definition order, and exactly one arm runs — the first match, or `else`.
The switch yields the chosen arm's value directly, like a ternary, so an
`as` binding on the switch never dangles. Arms see the enclosing scope
unchanged — no new frame roots — and the switch itself spawns no agent.
Missing predicate paths follow `evaluatePredicate` semantics: `eq`, `gt`,
`lt`, and `exists` are false, while `ne` and `empty` are true. Run trees mark
unselected arms as skipped (`⊖`) instead of leaving them pending. Dynamically
repeated switches wait until all choices are final before marking arms that no
instance selected.

### `value`

```yaml
kind: value
value:
  files: "{scout.files}"        # a lone reference substitutes the JSON value
  summary: "saw {scout.count}"  # mixed text interpolates as a string
  reviewed: true                # non-strings pass through
```

A pure data leaf: yields `value` with every string interpolated, spawning
no agent. A string that is exactly one `{reference}` substitutes the
referenced JSON value itself, preserving its type; any other string
interpolates as text. Useful for shaping outcomes and for switch arms that
should return an existing binding instead of running an echo agent.

### `workflow`

```yaml
kind: workflow
name: review
params: { target: "{previous}" }   # values interpolate in the caller's scope
as: rev
```

Inlined at validation time with cycle detection; budgets apply to the whole
expanded tree. A parameter value that is exactly one reference preserves the
referenced JSON type, so `params: {state: "{current}"}` can pass an object or
array to a value-only sub-workflow. An exact reference whose frame root is
undefined normalizes to `null`. Mixed text and declared parameter defaults
remain strings.

## 🎛️ Budgets

Every run enforces limits (tool parameter `budgets`, all optional):

| Budget             | Default | Meaning                                                     |
| ------------------ | ------- | ----------------------------------------------------------- |
| `maxAgents`        | 50      | Total agent and reducer executions; `0` prohibits them.      |
| `maxParallelism`   | 8       | Simultaneously running agents, global across nested pools.   |
| `maxIterations`    | 10      | Cap applied to every `loop` and `while`.                     |
| `maxDepth`         | 5       | Maximum process depth allowed before an agent spawn.         |
| `maxTurns`         | 250     | Assistant turns a single delegated agent may take.           |
| `maxAgentDuration` | —       | Wall-clock seconds a single delegated agent may run.         |
| `maxDuration`      | —       | Wall-clock seconds the whole run may take.                   |
| `maxTokens`        | —       | Input+output tokens (cache traffic excluded) a run may use.  |
| `maxCost`          | —       | USD a run may spend.                                         |

`maxAgents` is a non-negative integer. The other count budgets are positive
integers; in particular, `maxDepth` starts at `1`. Durations (seconds) and
`maxCost` (USD) accept fractional values. Budgets without a default are
unbounded unless set. The root interpreter accounts for every statically
composed node in one run and marks each delegated process with its depth
(`PI_AGENTS_DEPTH`). The marker keeps pi-agents inert if a child launches
another Pi process that inherits its environment; `maxDepth` remains a final
circuit breaker rather than a mechanism for dynamic child orchestration.

Set `maxAgents: 0` when a workflow must remain data-only:

```json
{
  "flow": {
    "kind": "sequence",
    "steps": [
      { "kind": "value", "value": "start" },
      { "kind": "value", "value": "done" }
    ]
  },
  "budgets": { "maxAgents": 0 }
}
```

Only executed `agent` nodes and reducers consume this budget. Structural and
`value` nodes do not, and agent nodes in unchosen `switch` arms or empty `map`
bodies remain unexecuted.

Exceeding a per-agent budget (`maxTurns`, `maxAgentDuration`) fails that agent
with a clear error and preserves its last streamed output as a partial result
— visible under `/workflow <id>` and persisted with the run's events. The usual
flow policies decide what happens next (`onError: "collect"` keeps sibling
results). Exceeding a run-scoped budget (`maxDuration`, `maxTokens`,
`maxCost`) fails the whole run and cancels still-running agents; token and
cost budgets are enforced at turn granularity, the finest level providers
report usage at.

Turn budgets are enforced from streamed activity: the cap trips when an
over-budget turn starts. An agent that has already settled successfully is
never failed retroactively on its final usage alone, so engines that report
usage only in their final outcome cannot be cut off mid-run.

## 🧭 Commands

| Command               | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `/agents`             | Browse discovered agents interactively (`list` for plain text). |
| `/agent <name>`       | Show one agent in full.                              |
| `/workflows`          | Browse workflows, their runs, and each run's agents interactively (`list`/`runs` for plain text, `widget` to toggle the live summary). |
| `/workflow <name>`    | Show one workflow: params, triggers, docs, flow.     |
| `/<name> [argument]`  | Run a saved workflow with one text argument.          |
| `/workflow <id>`      | Inspect a run (unique id prefixes work).             |
| `/workflow <id> copy`   | Copy the human-facing result to the clipboard in the TUI. |
| `/workflow <id> result` | Show the complete human-facing result.            |
| `/workflow <id> raw`    | Show the complete result value as highlighted JSON. |
| `/workflow <id> agents` | Per-agent status and output previews.              |
| `/workflow <id> watch`  | Snapshot now, final tree when the run settles.     |
| `/workflow <id> mermaid`| Deterministic Mermaid diagram of the run's flow.   |
| `/workflow <id> stop`   | Abort a live run.                                  |

A saved workflow command passes the complete text after its name to the first
declared parameter. It does not parse quoting, positional arguments, or
`key=value` pairs. A required parameter after the first must define a default
because a slash command cannot supply it.

`/workflow` resolves a saved workflow name first, then a run id; run ids are
hex, workflow names are slugs, so the two never collide in practice.

Completion cards render the complete presented result. String results use
Markdown, structured results use highlighted fenced JSON, and a run's
`display` path selects its human-facing Markdown value. Saved workflows can
declare the path, and inline or saved workflow calls can set or override it.
`/workflow <id> result` uses the same presentation, and `/workflow <id> copy`
copies that value without the completion card's metadata or controls. If the
path is missing or does not resolve to a string, these surfaces warn and fall
back to the complete result.
`/workflow <id> raw` always serializes the complete value as highlighted JSON.
Run and agent
detail panes also receive complete results, while their terminal viewport
controls how much is visible at once.

The payload sent to the calling model remains subject to a 200,000-character
safety ceiling. Larger values include a truncation notice and remain available
in full through `/workflow <id> raw`. Step-to-step interpolation uses the same
200,000-character ceiling.

### Interactive browsing

In the TUI, `/workflows` and `/agents` open a split-pane panel: a table on
top, the selected item's flow tree (or agent details) below. Scrolling moves
the detail pane with the selection and live runs refresh in place. The panel
opens in place of the composer — where pi shows `/settings` and `/model` — so
it appears right where you were typing instead of a screenful away on tall
terminals. It caps itself at roughly 80% of the terminal height to keep the
conversation visible above, the table never moves, and the detail pane only
ever grows downward.

Detail longer than that budget scrolls instead of pushing the panel taller:

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move the table selection |
| `⇧↑`/`⇧↓`, `J`/`K` (or `ctrl+y`/`ctrl+e`) | Scroll the detail pane one line |
| `⇧PgUp`/`⇧PgDn` (or `ctrl+u`/`ctrl+d`) | Scroll the detail pane one pane |
| `⇧Home`/`⇧End` | Jump to the start or end of the detail |

The footer advertises `⇧↑↓/JK scroll` only while there is something hidden. Each
row keeps its own window: moving the selection resets the offset, a live tail
starts pinned to the newest line, and scrolling back to the bottom of a tail
re-arms following.

The workflows panel is three tiers deep, mirroring the framework's three
nouns: workflows (with live run badges), one workflow's runs, and one run's
agents. `⏎` drills in, `esc` backs out one tier. Synthetic rows cover runs
that no saved workflow claims: `all runs` (the global, chronological view)
and `(ad-hoc)` (inline and tool-started flows).

```
╭─ Workflows (2/4) ──────────────────────────────────╮
│   ◉ all runs           every run this session ◉1 ●3│
│ ▸ ❖ /triage    user    Triage findings        ◉1 ●1│
│   ❖ /review   project  Structured code review   ●2│
├─ /triage · user · 2 runs ──────────────────────────┤
│ ❖ triage                                           │
│ ├─ ✦ scout → {files} · List files to review        │
│ └─ ⇶ map {files}                                   │
│    └─ ✦ reviewer · Review {item}                   │
╰─ ⏎ runs · c compose · r run · n new · esc ─────────╯
                         ⏎
╭─ Runs · /triage (1/2) ─────────────────────────────╮
│ ▸ ◉ 77aa01bc  running    triage (command)   $0.01  │
│   ● c9e5799a  completed  triage (command)   $0.21  │
├─ 77aa01bc · triage · 1m32s · 5 turns ↑33k ↓2k ─────┤
│ ● ❖ triage                                         │
│ ├─ ● ✦ scout → {files} · List files to review      │
│ └─ ◉ ⇶ map {files} (×4)                            │
│    └─ ◉ ✦ reviewer · Review {item} [2/4]           │
╰─ ⏎ inspect · a agents · c cancel · r rerun · esc ──╯
```

Keys — all tiers: `↑`/`↓` (or `k`/`j`) move, `esc` closes or backs out
one tier. Workflow tier: `⏎` drills into the selected workflow's runs, `c`
puts `/<name> ` into the composer, and `r` runs it immediately while the panel
stays open. If the first parameter requires input, `r` falls back to the
composer. If a later parameter is required, both actions keep the panel open
and direct you to the `workflow` tool or an RPC invocation. The `n` key starts
a new workflow or agent: you name it and describe the intent, and the model
drafts the definition file. Run tier: `⏎` posts the run details with the full
presented result to the chat, and `a` drills into the run's agents. The `c` key
cancels a running run or copies a settled run's presented result; settled runs
without a result omit it. The `r` key starts the same flow again, and `h`
shows/hides that run in the live summary above the composer (useful for
long-running flows). Agent tier: `⏎` posts the agent's full output, while `t`
opens a live, auto-following tail of its assistant output and tool activity.
The tail is a bounded in-memory peek and is not persisted as another agent
artifact. On a running agent, `s` opens an inline composer for a steering
message from either the agent list or its tail, so you can observe, correct
course, and keep watching. In the agents panel, `⏎` posts the full agent
details and `n` starts
a new definition.

The live summary widget shows each workflow's status and latest activity at a
glance, using provider reasoning summaries and active tool names. It keeps
every activity label visible for at least three seconds
and then retains it until a newer one arrives, coalescing rapid updates. The
widget can be toggled wholesale with `/workflows widget`.
There is no default keybinding for it; bind one via pi's keybindings if you
want one-keystroke access. While the workflows panel is open the summary hides
itself — the panel sits directly below it and reports the same run state — and
returns when you close the panel, leaving the toggle and any per-run `h`
choices untouched. It remains visible in the agents panel, which doesn't show
run state.

When
[pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
pi-agents also contributes two compact counters: `❖N` for active workflow
executions and `✦A/T` for completed and total agents across those executions.
They appear as `workflows` and `agents` in `/fancy-footer`, matching the
footer's own lowercase widget names. Both widgets are **off by default** and
can be enabled independently. They use the footer's event protocol directly, so pi-agents
has no package dependency on pi-fancy-footer. Snapshots are published only
when run state changes and when the footer announces that it is ready; there
is no polling interval.

In non-TUI modes (RPC, JSON, print) both commands keep their plain markdown
output.

## 🔐 Project trust

pi-agents honors Pi's current project-trust decision. In an untrusted
project, project-local agents and workflows (`.pi/agents`, `.pi/workflows`)
are invisible everywhere: they are not injected into the system prompt, not
registered as commands, never fired by event hooks, and per-node
`scope: project` overrides inside flows clamp to user scope. Passing
`scope: "project"` to the workflow tool in an untrusted project is an error.
Trust the project (pi's own prompt) and everything appears.

## 🗂️ Runs, background, and history

Runs are event-sourced into a sidecar file next to the session
(`<session>.pi-agents.jsonl`), so history survives reloads without ever
touching pi's session tree. Background runs (tool runs in interactive
sessions, all command and hook runs) keep writing to their origin session's
sidecar; results are delivered as notifications when that session is idle.
After a pi restart, in-flight runs are marked stopped — they cannot resume —
but their history remains inspectable.

### Steering live agents

Steering queues a course correction for an already-running delegated agent;
it does not start, resume, or restart one. Messages use Pi's deterministic
`one-at-a-time` steering mode, so delivery follows the current assistant
turn's tool-call batch. A message is limited to 2,000 characters and is added
to run history only after the child accepts it. Accepted messages appear in
the agent detail view and are persisted with their source (`user`, `tool`, or
`rpc`). Steering-triggered assistant turns count toward the run's normal usage
and turn totals.

Besides the `/workflows` panel, the model can call the separate `steer` tool with
a run ID (full or unique prefix), an optional exact node instance, and the
message. The instance may be omitted only while exactly one agent in that run
is steerable.

## 🔌 Event bus and RPC

In the originating Pi process, pi-agents exposes its live run stream and a small
control protocol through `pi.events`. The raw channels require no import from
this package; an optional typed client is exported from `pi-agents/api`.

| Channel | Payload |
|---|---|
| `pi-agents:ready` | `{ protocol: 1, version }` once per session start |
| `pi-agents:run-event` | `{ protocol: 1, event: RunEvent }` |
| `pi-agents:rpc:request` | `{ protocol: 1, id, caller?, op, params? }` |
| `pi-agents:rpc:reply:<id>` | Correlated success or error reply |

The run channel carries `run_created`, node lifecycle (including
`node_steered` after queue acceptance), loop/while iteration, `run_backgrounded`,
and `run_completed` events. These are detached, deeply frozen snapshots:
subscribers cannot mutate pi-agents' internal run state or the event seen by
later subscribers. Only new live events are published; use RPC `list` for the
current session's known run summaries.

Raw RPC callers must subscribe before emitting because replies may be
synchronous:

```ts
const id = crypto.randomUUID();
const replyChannel = `pi-agents:rpc:reply:${id}`;
const unsubscribe = pi.events.on(replyChannel, (reply) => {
  unsubscribe();
  console.log(reply);
});
pi.events.emit("pi-agents:rpc:request", {
  protocol: 1,
  id,
  caller: "my-extension",
  op: "start",
  params: { workflow: "review", params: { target: "src" } },
});
```

The typed client handles IDs, correlation, timeouts, and listener cleanup:

```ts
import { createPiAgentsClient } from "pi-agents/api";

const agents = createPiAgentsClient(pi, { caller: "my-extension" });
const off = agents.onRunEvent((event) => {
  if (event.type === "run_completed") console.log(event.status);
});
const { runId } = await agents.start({
  workflow: "review",
  params: { target: "src" },
  display: "report",
});
await agents.stop(runId); // only while the run is live
off();
```

RPC operations are `ping`, `start`, `stop`, `steer`, and `list`. `start`
accepts exactly one of an inline `flow` or saved `workflow`, optional literal
workflow parameters, label, and `display` path, and an optional absolute
existing `cwd`. A call-level `display` overrides the saved definition.
`start` confirms that the run was scheduled; it does not wait for a child agent
to become steerable. `steer` targets a currently running child and may reject
while a run is starting, between nodes, or waiting for capacity. It accepts an
exact `runId`, optional exact live node `instance`, and a message; omission of
`instance` is valid only when one agent is steerable at the time of the request.
RPC runs always run in the background, use the normal inherited/default
budgets, and obey the active session's project-trust decision. In untrusted
projects only user agents and workflows resolve. A `start` request made outside
an active session returns an error.

The RPC listener exists only in the root process. Delegated processes expose no
pi-agents event stream, control endpoint, or independent run list. A subscriber
may issue a guarded RPC request while handling a run event, but listeners that
automatically start work must filter specific transitions or deduplicate run
IDs to avoid creating their own event loop. Workflows cannot declare pi-agents'
public channels in `on:`; that integration remains deliberately unsupported.

## 📄 License

Apache-2.0
