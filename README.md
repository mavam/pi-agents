# 🤖 pi-agents

Multi-agent workflows for
[pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent),
built on an explicit algebra: every workflow is an expression tree in which
every node yields a value, and data flows only through references you write
down. No hidden context injection, no id-based cross-wiring — any subtree is
itself a valid workflow.

## 🚀 Installation

```sh
pi install npm:pi-agents
```

## 📖 Concepts

Three nouns carry the whole framework:

| Concept      | What it is                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **agent**    | A markdown file defining a delegated pi subprocess (`.pi/agents/*.md`).                           |
| **workflow** | A saved, named composition of agents (`.pi/workflows/*.md`) — or an inline expression.            |
| **run**      | One persisted execution of a workflow. Browse with `/runs`, inspect with `/run <id>`.             |

### The algebra

A workflow is a tree of six node kinds. Composition is purely structural:
`par` fuses fork and join into one expression, loops are bounded fixpoints,
and saved workflows inline like function calls.

| Node       | Meaning                                                        | Value                                     |
| ---------- | -------------------------------------------------------------- | ----------------------------------------- |
| `agent`    | Run one delegated agent on a task (the only leaf).              | Its final text, or parsed JSON.           |
| `seq`      | Run steps in order.                                             | The last step's value.                    |
| `par`      | Run named branches concurrently, optionally reduce.             | `{branch: value}`, or the reducer's value. |
| `map`      | Fan out a body per element of a runtime array.                  | Array of body values, or the reducer's.   |
| `loop`     | Repeat a body until a predicate holds or `max` is hit.          | The last iteration's value.               |
| `workflow` | Invoke a saved workflow by name (inlined, cycle-checked).       | The inlined flow's value.                 |

### Explicit data flow

Nothing flows between nodes implicitly. To pass data:

- Mark a `seq` step with `as: name`, then reference `{name}` (or a dot path
  like `{name.files.0}`) in any later step of that seq.
- `{previous}` is the immediately preceding step's value.
- A `map` body sees `{item}` and `{index}`; a `loop` body sees `{iteration}`
  and `{last}` (empty on the first iteration).
- Reduce tasks see `{branches}` (par) or `{items}` (map).
- Saved workflows see only their declared `{params.*}` — caller bindings are
  invisible, and param values are interpolated in the caller's scope.

Unknown references are validation errors with node paths, caught before
anything spawns. Use `output: json` on an upstream agent when downstream
steps need dot-path access or predicates. Escape literal braces as `{{`/`}}`.

## ⚡ Quick start

### 1. Define an agent

`.pi/agents/reviewer.md`:

```md
---
name: reviewer
description: Focused code review from a single lens
model: claude-sonnet-4-5   # optional; defaults to the active session model
thinking: medium           # optional: off|minimal|low|medium|high|xhigh
skills: []                 # optional pi skills to inject
tools: [read, grep, find]  # optional allowlist; [] means NO tools at all
---

You are a review agent. Review code through exactly the lens given in your
task. Return concrete findings with file paths.
```

Agents are discovered from `~/.pi/agents` (user) and the nearest `.pi/agents`
walking up from the cwd (project); project wins on name conflicts.

### 2. Define a workflow

`.pi/workflows/review.md`:

````md
---
name: review
description: Multi-lens code review with a synthesis pass
whenToUse: when the user asks for a thorough review
params:
  - name: target
    required: true
---

Reviews the target from two lenses concurrently, then merges findings.

```yaml
kind: par
branches:
  bugs:    { kind: agent, name: reviewer, task: "Find bugs in {params.target}" }
  clarity: { kind: agent, name: reviewer, task: "Review {params.target} for clarity" }
reduce:
  agent: worker
  task: "Merge and prioritize:\n{branches}"
```
````

Frontmatter + one fenced `yaml` or `json` block holding the flow; the prose
around it is documentation. Workflows live in `~/.pi/workflows` and
`.pi/workflows`, discovered like agents. Every definition is fully validated
at discovery (references, cycles, binding scopes); invalid files are listed
in `/workflows` diagnostics and never run.

### 3. Trigger it

Workflows fire from three surfaces:

1. **The model.** Saved workflows (name, description, `whenToUse`, params)
   are advertised in the system prompt; the model runs them — or composes
   ad-hoc flows — through the single `workflow` tool. In interactive
   sessions runs go to the background: the widget shows progress and the
   result arrives as a notification.
2. **You.** Every saved workflow registers a slash command:
   `/review src/core` runs the graph directly, with args bound to params —
   no model round-trip. Positional args and `key=value` pairs both work.
3. **Events.** Add `on: [turn_end]` (plus optional `debounce:` milliseconds)
   to the frontmatter and the workflow fires on those pi events, always in
   the background, with the event payload bound as `{params.event}`.
   Hooks run only in the root pi process, never inside delegated children.

## 🧮 Node reference

### `agent`

```yaml
kind: agent
name: reviewer          # must match a discovered agent
task: "Review {previous}"
output: text            # or "json": parse the result (fences tolerated)
as: findings            # binding name; only legal on direct seq steps
cwd: /path/override     # optional
scope: both             # agent discovery: user|project|both
```

A bare `agent` node is a complete workflow — single delegation needs nothing
more.

### `seq`

```yaml
kind: seq
steps:
  - { kind: agent, name: scout, task: "Map the code", as: map }
  - { kind: agent, name: planner, task: "Plan using {map}" }
  - { kind: agent, name: worker, task: "Implement {previous}" }
```

### `par`

```yaml
kind: par
branches:
  a: { kind: agent, name: x, task: "..." }
  b: { kind: agent, name: y, task: "..." }
mode: all               # "all" (default) | "any" | { quorum: n }
onError: fail           # "fail" (default, cancels siblings) | "collect"
concurrency: 4          # cap on simultaneous branches
reduce:                 # optional fold over the collected value
  agent: synthesizer
  task: "Merge {branches}"
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

| Budget           | Default | Meaning                                                  |
| ---------------- | ------- | -------------------------------------------------------- |
| `maxAgents`      | 50      | Total agent spawns (reducers included).                   |
| `maxParallelism` | 4       | Simultaneously running agents, global across nested pools. |
| `maxIterations`  | 10      | Cap applied to every loop.                                |
| `maxDepth`       | 3       | Cross-process delegation depth.                           |

Values must be positive integers. The effective limits are inherited by
delegated pi processes (via `PI_AGENTS_BUDGETS`), so a child that runs
pi-agents itself starts from the parent's limits rather than the defaults.

## 🧭 Commands

| Command               | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `/agents`             | List discovered agents.                              |
| `/agent <name>`       | Show one agent in full.                              |
| `/workflows`          | List saved workflows (with validation diagnostics).  |
| `/workflow <name>`    | Show one workflow: params, triggers, docs, flow.     |
| `/<name> [args]`      | Run saved workflow `<name>` directly.                |
| `/runs`               | Browse runs.                                         |
| `/run <id>`           | Inspect a run (unique id prefixes work).             |
| `/run <id> result`    | The complete result value of a finished run.         |
| `/run <id> watch`     | Snapshot now, final tree when the run settles.       |
| `/run <id> mermaid`   | Deterministic Mermaid diagram of the run's flow.     |
| `/run <id> stop`      | Abort a live run.                                    |

## 🔐 Project trust

pi-agents honors pi's project-trust decision (pi ≥ 0.80). In an untrusted
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

## 🧹 Uninstall

```sh
pi remove npm:pi-agents
```

## 📄 License

Apache-2.0
