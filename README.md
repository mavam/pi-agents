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

Zero configuration required. Right after installing, the model can delegate
and compose work with anonymous **ad-hoc agents** — no agent files needed:

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

## 📖 Concepts

Three nouns carry the whole framework:

| Concept      | What it is                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **agent**    | A delegated pi subprocess: anonymous (ad-hoc, just a task) or a reusable persona defined in a markdown file (`.pi/agents/*.md`). |
| **workflow** | A saved, named composition of agents (`.pi/workflows/*.yaml`) — or an inline expression.           |
| **run**      | One persisted execution of a workflow. Browse with `/workflows`, inspect with `/workflow <id>`.  |

### The algebra

A workflow is a tree of eight node kinds. Composition is purely structural:
`parallel` fuses fork and join into one expression, loops are bounded fixpoints,
and saved workflows inline like function calls.

| Icon | Node       | Meaning                                                   | Value                                      |
| :--: | ---------- | --------------------------------------------------------- | ------------------------------------------ |
| `✦`  | `agent`    | Run one delegated agent on a task (the only leaf).        | Its final message's text, or parsed JSON.  |
| `≡`  | `sequence` | Run steps in order.                                       | The last step's value.                     |
| `⑃`  | `parallel` | Run named branches concurrently, optionally `⑂` reduce.   | `{branch: value}`, or the reducer's value. |
| `⇶`  | `map`      | Fan out a body per element of a runtime array.            | Array of body values, or the reducer's.    |
| `↺`  | `loop`     | Repeat a body until a predicate holds or `max` is hit.    | The last iteration's value.                |
| `⎇`  | `switch`   | Route to the first arm whose predicate matches a value.   | The chosen arm's value.                    |
| `≔`  | `value`    | Yield a template-interpolated JSON value (no agent).      | The interpolated value.                    |
| `❖`  | `workflow` | Invoke a saved workflow by name (inlined, cycle-checked). | The inlined flow's value.                  |

The JSON/YAML form is what you author; the icons are how flows are *read*.
Every surface that shows a flow — the tool call display, `/workflow <name>`,
`/workflow <run-id>` — renders it as an icon tree. The review workflow, for
example:

```
⑃ parallel (all)
├─ bugs → ✦ reviewer · Review {params.target} strictly for correctness bug…
├─ clarity → ✦ reviewer · Review {params.target} for readability, duplicat…
└─ ⑂ reduce → worker · Merge these code review findings into one prioriti…
```

Sequences are transparent — their steps appear at the parent level without
extra nesting. When inspecting a run, the kind icons are replaced by live
status icons (`○` pending, `◉` running, `●` completed, `✗` failed,
`⊘` cancelled), with dynamic fan-out aggregated in place:

```
● scout → {files} · List files to review
◉ reviewer · Review {item} [3/5]
○ reduce → synthesizer · Merge {items}
```

### Explicit data flow

Nothing flows between nodes implicitly. To pass data:

- Mark a `sequence` step with `as: name`, then reference `{name}` (or a dot path
  like `{name.files.0}`) in any later step of that sequence.
- `{previous}` is the immediately preceding step's value.
- A `map` body sees `{item}` and `{index}`; a `loop` body sees `{iteration}`
  and `{last}` (empty on the first iteration).
- Reduce tasks see `{branches}` (parallel) or `{items}` (map).
- Saved workflows see only their declared `{params.*}` — caller bindings are
  invisible, and param values are interpolated in the caller's scope.

Unknown references are validation errors with node paths, caught before
anything spawns. Use `output: json` on an upstream agent when downstream
steps need dot-path access or predicates. Escape literal braces as `{{`/`}}`.

## ⚡ Quick start

### 1. (Optional) Define an agent profile

Agent files exist for *reuse*: a persona, tool allowlist, skills, and model
defaults you want to apply consistently across flows. Don't create one for a
one-off delegation — omit `name` and let an ad-hoc agent do it.

`.pi/agents/reviewer.md`:

```md
---
name: reviewer
description: Focused code review from a single lens
model: openai-codex/gpt-5.6-terra  # optional; defaults to the active session model
thinking: medium           # optional: off|minimal|low|medium|high|xhigh
skills: []                 # optional pi skills to inject
tools: [read, grep, find]  # optional allowlist; [] means NO tools at all
---

You are a review agent. Review code through exactly the lens given in your
task. Return concrete findings with file paths.
```

Agents are discovered from `~/.pi/agent/agents` (user) and the nearest `.pi/agents`
walking up from the cwd (project); project wins on name conflicts. An agent
is purely a persona — the *who*. The *what* (a task) always comes from the
flow that references it; for a named, reusable agent+task unit, use a flat
workflow (below).

### 2. Define a workflow

Workflows are pure data: one YAML or JSON object per file, the extension
decides the parser (`.yaml`, `.yml`, `.json`). `.pi/workflows/review.yaml`:

```yaml
name: review
description: Multi-lens code review with a synthesis pass
trigger: when the user asks for a thorough review
doc: >-
  Optional prose documentation lives here.
params:
  - name: target
    required: true
flow:
  kind: parallel
  branches:
    bugs:    { kind: agent, name: reviewer, task: "Find bugs in {params.target}" }
    clarity: { kind: agent, name: reviewer, task: "Review {params.target} for clarity" }
  reduce:
    agent: worker
    task: "Merge and prioritize:\n{branches}"
```

For a single-unit workflow — one task, no graph — skip `flow:` entirely and
use the flat form, which normalizes to a bare agent leaf but keeps full
workflow powers (params, `/name` command, `on:` hooks, and
`{kind: workflow, name: …}` references from other flows). `agent:` is
optional; without it the task runs as an ad-hoc agent:

```yaml
name: summarize
description: Summarize a target
params: [{ name: target, required: true }]
task: "Summarize {params.target}"
thinking: high
```

```yaml
name: bug-hunt
description: Hunt correctness bugs in a target
params: [{ name: target, required: true }]
agent: reviewer # optional: use the reviewer profile
task: "Review {params.target} strictly for bugs."
```

Workflows live in `~/.pi/agent/workflows` and `.pi/workflows`, discovered like
agents. Every definition is fully validated at discovery (references, cycles,
binding scopes); invalid files are listed in `/workflows` diagnostics and
never run.

### 3. Trigger it

Workflows fire from four surfaces:

1. **The model.** Saved workflows (name, description, `trigger`, params)
   are advertised in the system prompt; the model runs them — or composes
   ad-hoc flows — through the single `workflow` tool. The tool is
   **opt-in**: the model may only reach for it when you affirmatively ask
   for something to run — "run the review workflow", "delegate this", "do
   these in parallel" — or for a saved workflow you asked for by name or by
   its `trigger` situation. Merely saying *workflow* is not a request, and
   neither is a task that looks big or parallelizable. In interactive
   sessions runs go to the background: the widget shows progress and the
   result arrives as a notification.
2. **You.** Every saved workflow registers a slash command:
   `/review src/core` runs the graph directly, with args bound to params —
   no model round-trip. Positional args and `key=value` pairs both work.
3. **Events.** Add `on: [turn_end]` (plus optional `debounce:` milliseconds)
   and the workflow fires on those pi events, always in the background,
   with the event payload bound as `{params.event}`. Hooks run only in the
   root pi process, never inside delegated children.
4. **Other extensions.** Co-loaded pi extensions can start, stop, and inspect
   runs over the in-process event bus. See [Event bus and RPC](#-event-bus-and-rpc).

## 🛠️ The `workflow` tool: ad-hoc flows from the model

The model is a first-class workflow author, not just an invoker. The single
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
          "core":  { "kind": "agent", "name": "reviewer", "task": "Review src/core" },
          "run":   { "kind": "agent", "name": "reviewer", "task": "Review src/run" },
          "ui":    { "kind": "agent", "name": "reviewer", "task": "Review src/ui" }
        },
        "reduce": { "agent": "worker", "task": "List findings all reviews agree on:\n{branches}", "output": "json" } },
      { "kind": "agent", "name": "worker", "task": "Fix these agreed findings: {previous}" }
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

## 🧮 Node reference

### `agent`

```yaml
kind: agent
task: "Review {previous}"
name: reviewer          # optional; must match a discovered agent profile
output: text            # or "json": parse the result (fences tolerated)
model: some-model       # optional override (wins over the agent file)
thinking: low           # optional override (wins over the agent file)
as: findings            # binding name; only legal on direct sequence steps
cwd: /path/override     # optional
scope: both             # agent discovery: user|project|both
```

A bare `agent` node is a complete workflow — single delegation needs nothing
more. Without `name` the node runs as an anonymous ad-hoc agent (rendered as
`ad-hoc`): no profile prompt, default tools, session model/thinking.
Precedence for model/thinking: flow node → agent file (named only) → active
session.

**Value contract.** An agent's value is the text of its *last* assistant
message — nothing else. Thinking, tool calls, tool output, and earlier
messages are discarded (they only feed the live progress display), and the
subprocess runs without a session, so no transcript exists anywhere: the
final message is the delegated agent's sole artifact. With `output: json`
that text is parsed into a JSON value (code fences tolerated; a parse
failure fails the node). Write tasks so the agent *ends* with the complete
deliverable — an agent that reports findings mid-session and closes with
"done" yields the value `"done"`. Every delegated agent — ad-hoc ones
included — has this contract appended to its system prompt, and `output:
json` additionally instructs it to reply with a single raw JSON value.

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
```

Value: `all`/`quorum` yield `{branch: value}`; `any` yields the winner's
value and cancels the rest. With `onError: collect`, failed branches appear
as `{error: "..."}` entries and the node fails only when every branch fails.

### `map`

```yaml
kind: map
over: "{scout.files}"   # must resolve to a JSON array at runtime
body:
  kind: agent
  name: reviewer
  task: "Review {item} (#{index})"
concurrency: 4
reduce: { agent: synthesizer, task: "Combine {items}" }
```

Dynamic fan-out: the body runs once per array element, results return in
input order, and any item failure cancels the rest and fails the node.

### `loop`

```yaml
kind: loop
body: { kind: agent, name: fixer, task: "Iteration {iteration}; prior: {last}", output: json }
max: 3
until: { eq: ["done", true] }
```

Predicates address the body's JSON value by dot path (`""` is the whole
value): `eq`, `ne`, `gt`, `lt`, `exists`, `empty`, composed with `and`,
`or`, `not`.

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
the cases' predicates (the same language as `loop.until`) are tried in
definition order, and exactly one arm runs — the first match, or `else`.
The switch yields the chosen arm's value directly, like a ternary, so an
`as` binding on the switch never dangles. Arms see the enclosing scope
unchanged — no new frame roots — and the switch itself spawns no agent.
Missing predicate paths follow `evaluatePredicate` semantics: `eq`, `gt`,
`lt`, and `exists` are false, while `ne` and `empty` are true.

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
expanded tree.

## 🎛️ Budgets

Every run enforces limits (tool parameter `budgets`, all optional):

| Budget             | Default | Meaning                                                     |
| ------------------ | ------- | ----------------------------------------------------------- |
| `maxAgents`        | 50      | Total agent and reducer executions; `0` prohibits them.      |
| `maxParallelism`   | 8       | Simultaneously running agents, global across nested pools.   |
| `maxIterations`    | 10      | Cap applied to every loop.                                   |
| `maxDepth`         | 5       | Cross-process delegation depth.                              |
| `maxTurns`         | 100     | Assistant turns a single delegated agent may take.           |
| `maxAgentDuration` | —       | Wall-clock seconds a single delegated agent may run.         |
| `maxDuration`      | —       | Wall-clock seconds the whole run may take.                   |
| `maxTokens`        | —       | Input+output tokens (cache traffic excluded) a run may use.  |
| `maxCost`          | —       | USD a run may spend.                                         |

`maxAgents` is a non-negative integer. The other count budgets are positive
integers; in particular, `maxDepth` starts at `1`. Durations (seconds) and
`maxCost` (USD) accept fractional values. Budgets without a default are
unbounded unless set. The effective limits are inherited by delegated pi
processes (via `PI_AGENTS_BUDGETS`), so a child that runs pi-agents itself starts
from the parent's limits rather than the defaults; run-scoped limits apply per
process, not aggregated across the delegation tree.

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
| `/<name> [args]`      | Run saved workflow `<name>` directly.                |
| `/workflow <id>`      | Inspect a run (unique id prefixes work).             |
| `/workflow <id> result` | The complete result value of a finished run.       |
| `/workflow <id> agents` | Per-agent status and output previews.              |
| `/workflow <id> watch`  | Snapshot now, final tree when the run settles.     |
| `/workflow <id> mermaid`| Deterministic Mermaid diagram of the run's flow.   |
| `/workflow <id> stop`   | Abort a live run.                                  |

`/workflow` resolves a saved workflow name first, then a run id; run ids are
hex, workflow names are slugs, so the two never collide in practice.

A completed workflow can send up to 200,000 characters to the calling model.
Larger values include a truncation notice and remain available in full through
`/workflow <id> result`. Completion cards show a compact preview to keep the
transcript responsive, and step-to-step interpolation uses the same
200,000-character ceiling.

### Interactive browsing

In the TUI, `/workflows` and `/agents` open a split-pane overlay: a table on
top, the selected item's flow tree (or agent details) below. Scrolling moves
the detail pane with the selection, live runs refresh in place, and the
overlay is pinned near the top of the screen — the table never moves; the
detail pane only ever grows downward.

The workflows overlay is three tiers deep, mirroring the framework's three
nouns: workflows (with live run badges), one workflow's runs, and one run's
agents. `⏎` drills in, `esc` backs out one tier. Synthetic rows cover runs
that no saved workflow claims: `all runs` (the global, chronological view)
and `(ad-hoc)` (inline and tool-started flows).

```
╭─ Workflows (2/4) ──────────────────────────────────╮
│   ◉ all runs           every run this session ◉1 ●3│
│ ▸ ❖ /triage    user    Triage findings        ◉1 ●1│
│   ❖ /review   project  Multi-lens code review    ●2│
├─ /triage · user · 2 runs ──────────────────────────┤
│ ✦ scout → {files} · List files to review           │
│ ⇶ map {files}                                      │
│ └─ ✦ reviewer · Review {item}                      │
╰─ ⏎ runs · c compose · r run · n new · esc ─────────╯
                         ⏎
╭─ Runs · /triage (1/2) ─────────────────────────────╮
│ ▸ ◉ 77aa01bc  running    triage (command)   $0.01  │
│   ● c9e5799a  completed  triage (command)   $0.21  │
├─ 77aa01bc · triage · 1m32s · 5 turns ↑33k ↓2k ─────┤
│  ● scout → {files} · List files to review          │
│  ⇶ map {files} (×4)                                │
│     └─ ◉ reviewer · Review {item} [2/4]            │
╰─ ⏎ inspect · a agents · c cancel · r rerun · esc ──╯
```

Keys — all overlays: `↑`/`↓` (or `k`/`j`) move, `esc` closes or backs out
one tier. Workflow tier: `⏎` drills into the selected workflow's runs, `c`
puts `/<name> ` into the composer so you can add arguments, `r` runs it
immediately (workflows with required parameters fall back to composing),
and `n` starts a new workflow or agent: you name it and describe the
intent, the model drafts the definition file. Run tier: `⏎` posts the run
details with the full result to the chat, `a` drills into the run's agents,
`c` cancels a live run, `r` starts the same flow again, and `h` shows/hides
that run in the live summary above the composer (useful for long-running
flows). Agent tier: `⏎` posts the agent's full output, while `t` opens a live,
auto-following tail of its assistant output and tool activity. The tail is a
bounded in-memory peek and is not persisted as another agent artifact. On a
running agent, `s` opens an inline composer for a steering message from either
the agent list or its tail, so you can observe, correct course, and keep
watching. In the agents overlay, `⏎` posts the full agent details and `n` starts
a new definition.

The live summary widget can be toggled wholesale with `/workflows widget`.
There is no default keybinding for it; bind one via pi's keybindings if you
want one-keystroke access.

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

Besides the `/workflows` overlay, the model can call the separate `steer` tool with
a run ID (full or unique prefix), an optional exact node instance, and the
message. The instance may be omitted only while exactly one agent in that run
is steerable.

## 🔌 Event bus and RPC

pi-agents exposes its live run stream and a small control protocol through
`pi.events`. The raw channels require no import from this package; an optional
typed client is exported from `pi-agents/api`.

| Channel | Payload |
|---|---|
| `pi-agents:ready` | `{ protocol: 1, version }` once per session start |
| `pi-agents:run-event` | `{ protocol: 1, event: RunEvent }` |
| `pi-agents:rpc:request` | `{ protocol: 1, id, caller?, op, params? }` |
| `pi-agents:rpc:reply:<id>` | Correlated success or error reply |

The run channel carries `run_created`, node lifecycle (including
`node_steered` after queue acceptance), loop iteration, `run_backgrounded`,
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
const { runId } = await agents.start({ workflow: "review", params: { target: "src" } });
await agents.stop(runId); // only while the run is live
off();
```

RPC operations are `ping`, `start`, `stop`, `steer`, and `list`. `start`
accepts exactly one of an inline `flow` or saved `workflow`, optional literal
workflow parameters and label, and an optional absolute existing `cwd`.
`start` confirms that the run was scheduled; it does not wait for a child agent
to become steerable. `steer` targets a currently running child and may reject
while a run is starting, between nodes, or waiting for capacity. It accepts an
exact `runId`, optional exact live node `instance`, and a message; omission of
`instance` is valid only when one agent is steerable at the time of the request.
RPC runs always run in the background, use the normal inherited/default
budgets, and obey the active session's project-trust decision. In untrusted
projects only user agents and workflows resolve. A `start` request made outside
an active session returns an error.

The RPC listener is installed at every delegation depth. Because the bus is
process-local, the root session and each delegated pi process expose independent
RPC endpoints and run lists. A subscriber may issue a guarded RPC request while
handling a run event, but listeners that automatically start work must filter
specific transitions or deduplicate run IDs to avoid creating their own event
loop. Workflows cannot declare pi-agents' public channels in `on:`; that
integration remains deliberately unsupported.

## 📄 License

Apache-2.0
