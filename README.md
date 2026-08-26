# 🤖 pi-agents

Run explicit, composable multi-agent workflows in [Pi](https://pi.dev). Use one
agent for a focused task, run several in parallel, or connect agents
with sequences, maps, loops, conditions, and reducers.

Every workflow node returns a value. Data moves between nodes only through
references such as `{previous}`, `{review}`, or `{item}`. Because nothing
flows implicitly, Pi validates every reference before the run starts, and a
broken data dependency fails before any agent spawns.

## 🚀 Installation

```sh
pi install npm:pi-agents
```

The package works without configuration. It includes `/review`, a read-only
code review workflow.

## ✨ Quick start

Ask Pi explicitly to delegate work:

```text
Delegate a review of src/run to an agent.
```

```text
Review src/run and src/ui in parallel, then merge the findings.
```

Pi starts workflows only when you ask for delegation, parallel agents, or a
saved workflow. Mentioning a workflow or asking how one works does not start
it.

The model can create an inline workflow without any agent or workflow files:

```json
{
  "flow": {
    "kind": "parallel",
    "branches": {
      "bugs": { "kind": "agent", "task": "Review src/run for bugs" },
      "clarity": { "kind": "agent", "task": "Review src/run for clarity" }
    },
    "reduce": { "task": "Merge and prioritize these reviews:\n{branches}" }
  },
  "label": "review src/run"
}
```

An agent without a `profile` is anonymous and ad hoc. It inherits the current
model and thinking level unless the node overrides them.

## 📖 Core concepts

| Concept | Meaning |
| --- | --- |
| **Agent** | One delegated Pi session working on a task. It can be anonymous or use a saved profile. |
| **Workflow** | A saved or inline composition of agents and control-flow nodes. |
| **Run** | One persisted execution of a workflow. |

### Workflow nodes

| Node | Purpose | Result |
| --- | --- | --- |
| `agent` | Run one delegated agent. | The agent's submitted result. |
| `sequence` | Run steps in order. | The last step's result. |
| `parallel` | Run named branches concurrently. | An object of branch results, or a reducer result. |
| `map` | Run a body for each item in an array. | An array of results, or a reducer result. |
| `loop` | Run a body at least once, then test a condition. | The last result. |
| `while` | Carry a value through a body while a condition holds. | The final carried value. |
| `switch` | Select the first matching branch. | The selected branch's result. |
| `value` | Return interpolated JSON without starting an agent. | The interpolated value. |
| `workflow` | Invoke a saved workflow. | The saved workflow's result. |

### Data flow

Name a sequence step with `as`, then reference its result later:

```yaml
kind: sequence
steps:
  - kind: agent
    task: Find files that need review
    as: discovery
    json:
      type: object
      required: [files]
      properties:
        files:
          type: array
          items: { type: string }
  - kind: map
    over: "{discovery.files}"
    body:
      kind: agent
      task: "Review {item}"
```

Available references depend on the node:

- Sequence steps can use named earlier results and `{previous}`.
- Map bodies receive `{item}` and `{index}`.
- Loop bodies receive `{iteration}` and `{last}`.
- While bodies receive `{iteration}` and `{current}`.
- Parallel reducers receive `{branches}`.
- Map reducers receive `{items}`.
- Saved workflows receive their declared `{params.*}` values.

A string containing only one reference preserves the referenced JSON type.
References mixed with other text produce a string. Escape literal braces as
`{{` and `}}`.

Pi validates references before starting the run. Add a `json` schema to an
agent when later nodes need fields from its result.

## 🧑‍💻 Create an agent profile

Profiles are optional. Use one when you want to reuse a persona or a common
set of model, skill, and tool settings.

Create `.pi/agents/planner.md`:

```md
---
name: planner
description: Maps a codebase and proposes implementation plans
thinking: medium
skills: []
tools: [read, grep, find]
---

Map the relevant code and return a concrete implementation plan with file
paths. Do not edit files.
```

Reference it from a workflow:

```yaml
kind: agent
profile: planner
task: Plan the requested change
```

Pi-agents discovers agent profiles in:

- User: `~/.pi/agent/agents`
- Project: `<project>/.pi/agents`

The nearest ancestor containing `.pi` is the project resource root. Project
profiles take precedence over user profiles with the same name.

Agent-node settings override profile settings, which override the active Pi
session. Lists replace rather than merge:

- Omit `skills` to retain ambient skill discovery for an ad-hoc agent.
- Set `skills: []` to disable skill discovery.
- Set `tools: []` to give the agent no working tools.
- Use `scope: user`, `scope: project`, or `scope: both` to control profile and
  skill discovery.

Named skills resolve from `<project>/.pi/skills`, `.agents/skills` up to the
Git root, `~/.pi/agent/skills`, and `~/.agents/skills` according to `scope`.
Unknown profile and skill names fail validation before the run starts.

## 🧩 Create a saved workflow

Save workflows as YAML or JSON in one of these directories:

- User: `~/.pi/agent/workflows`
- Project: `<project>/.pi/workflows`

A flat workflow describes one agent. For example, `.pi/workflows/review.yaml`:

```yaml
name: review
description: Review a target with structured findings
trigger: when the user asks for a read-only code review
display: report
params:
  - { name: target, required: true }
  - { name: focus, default: "Apply normal risk-based lens selection." }
task: |-
  Review {params.target}.
  Focus: {params.focus}
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

A composed workflow uses `flow`:

```yaml
name: inspect-and-fix
description: Inspect two areas, merge findings, then fix them
params:
  - { name: target, required: true }
flow:
  kind: sequence
  steps:
    - kind: parallel
      as: reviews
      branches:
        behavior:
          kind: agent
          task: "Review {params.target} for correctness"
        tests:
          kind: agent
          task: "Review {params.target} for missing tests"
      reduce:
        task: "Merge and prioritize:\n{branches}"
    - kind: agent
      task: "Fix these findings:\n{reviews}"
```

Each saved workflow registers a slash command. `/review src/run` passes
`src/run` to the first declared parameter. Slash commands accept one free-form
text argument; use `workflow_create` when you need several named parameters.

### Human-facing results

A run can return structured data while presenting one Markdown string to the
user. The default is the `report` convention: when a structured result
contains a top-level `report` string, completion cards and
`/workflow <id> result` render it as Markdown. Without `report`, the UI shows
the complete structured result. Parent workflows always receive the complete
value. `workflow_result` returns the complete value by default and applies the
human-facing selection only with `view: "presented"`; use `/workflow <id> raw`
to inspect it in the UI.

Saved workflows may instead pin an explicit dot path with `display`, which
overrides the convention:

```yaml
display: report
```

Request-time presentation settings are best effort. An invalid `display` or
`label`, or a `display` path that is missing from the completed value, produces
a run warning and falls back without failing execution. Saved workflow files
validate `display` strictly and report malformed definitions in the catalog.

### Agent results

A delegated agent must submit one final result that matches its `json` schema.
Without `json`, the result must be a string. Assistant messages, thinking,
tool calls, and tool output are progress; the last visible assistant message
is not used as an implicit result.

An agent that cannot complete its task can submit an error with a reason. The
node then fails, and the surrounding workflow applies its configured error
policy.

## 🧮 Compose workflows

### Sequence

```yaml
kind: sequence
steps:
  - { kind: agent, task: Map the code, as: map }
  - { kind: agent, task: "Plan using {map}" }
  - { kind: agent, task: "Implement {previous}" }
```

### Parallel

```yaml
kind: parallel
branches:
  a: { kind: agent, task: Review module A }
  b: { kind: agent, task: Review module B }
mode: all               # all | any | { quorum: 1 }
onError: fail           # fail | collect
concurrency: 4
reduce:
  task: "Merge {branches}"
```

`mode: any` returns the first successful result and cancels the remaining
branches. `onError: collect` keeps failures as `{error: "..."}` values unless
every branch fails.

### Map

```yaml
kind: map
over: "{discovery.files}"
concurrency: 4
body:
  kind: agent
  task: "Review {item}"
reduce:
  task: "Combine {items}"
```

Map results preserve input order.

### Loop

```yaml
kind: loop
max: 3
body:
  kind: agent
  task: "Iteration {iteration}; previous result: {last}"
  json:
    type: object
    required: [done]
    properties: { done: { type: boolean } }
until: { eq: [done, true] }
```

A loop runs at least once. It stops when `until` matches or when it reaches
`max`.

### While

```yaml
kind: while
on: "{initial_state}"
condition: { eq: [outcome, changes_required] }
max: 3
body:
  kind: agent
  task: "Round {iteration}; fix {current.actionable}"
```

A while node checks its condition before each iteration. It can run zero
times. The body's result becomes the next `{current}` value.

### Switch

```yaml
kind: switch
on: "{review}"
cases:
  - when: { eq: [outcome, approved] }
    then: { kind: value, value: approved }
  - when: { exists: actionable }
    then: { kind: agent, task: "Fix {review.actionable}" }
else:
  kind: value
  value: cannot-proceed
```

Switch cases run in order. The first matching case wins, and `else` is
required.

Predicates support `eq`, `ne`, `gt`, `lt`, `exists`, and `empty`, plus `and`,
`or`, and `not`.

### Saved workflow

```yaml
kind: workflow
name: review
params:
  target: "{previous}"
```

Pi-agents expands saved workflows into the caller's run. Cycles fail
validation.

## 🎛️ Budgets

Set optional limits on a run:

| Budget | Default | Meaning |
| --- | ---: | --- |
| `maxAgents` | `50` | Total agent and reducer executions. Set `0` for a data-only workflow. |
| `maxParallelism` | `8` | Agents that can run simultaneously. |
| `maxIterations` | `10` | Default cap for every loop and while node. |
| `maxDepth` | `5` | Maximum delegated process depth. |
| `maxTurns` | `250` | Assistant turns per delegated agent. |
| `maxAgentDuration` | Unbounded | Seconds per delegated agent. |
| `maxDuration` | Unbounded | Seconds for the complete run. |
| `maxTokens` | Unbounded | Input and output tokens, excluding cache traffic. |
| `maxCost` | Unbounded | Total cost in USD. |

Example:

```json
{
  "name": "review",
  "params": { "target": "src" },
  "budgets": {
    "maxAgents": 8,
    "maxDuration": 300,
    "maxCost": 1.0
  }
}
```

An agent or run that exceeds a limit fails and preserves the latest available
output. If you are attached to an agent, enforcement waits until you detach;
usage accounting continues while you are attached.

## 🧭 Run and inspect workflows

### Commands

| Command | Action |
| --- | --- |
| `/agents` | Browse agent profiles. Add `list` for plain text. |
| `/agent <name>` | Show one profile. |
| `/workflows` | Browse workflows, runs, and delegated agents. |
| `/workflow <name>` | Show a saved workflow. |
| `/<name> [argument]` | Run a saved workflow. |
| `/workflow <id>` | Inspect a run. Unique ID prefixes work. |
| `/workflow <id> result` | Show the human-facing result. |
| `/workflow <id> raw` | Show the complete result as JSON. |
| `/workflow <id> copy` | Copy the human-facing result. |
| `/workflow <id> agents` | Show per-agent status and output. |
| `/workflow <id> watch` | Wait for a live run and show its final tree. |
| `/workflow <id> mermaid` | Show the run as a Mermaid diagram. |
| `/workflow <id> stop` | Stop a live run. |
| `/agent-session <run-id> [node]` | Open a settled agent's Pi session. |

### Model-facing tools

Pi uses one tool for each run operation:

| Tool | Action |
| --- | --- |
| `workflow_create` | Start a saved workflow or an inline flow. |
| `workflow_list` | List runs. |
| `workflow_inspect` | Inspect live state, usage, and errors. |
| `workflow_result` | Retrieve a run or node result. |
| `workflow_stop` | Stop a live run after you request cancellation. |

These tools see runs from the current Pi session. Large lists and results use
cursor-based pagination.

### Interactive browser

`/workflows` opens a browser with three levels: workflows, runs, and agents.
Use these keys:

| Key | Action |
| --- | --- |
| `↑`/`↓` or `j`/`k` | Move the selection. |
| `Enter` | Open the selected item or attach to an agent. |
| `Esc` | Go back or close the browser. |
| `r` | Run or rerun the selected workflow. |
| `c` | Compose a command, cancel a live run, or copy a completed result, depending on the current view. |
| `a` | Open a run's agents. |
| `o` | Post an agent's output to the parent conversation. |
| `h` | Show or hide a run in the live panel. |
| `n` | Draft a new workflow or agent profile. |
| `Shift+↑`/`Shift+↓` | Scroll details or an attached transcript. |

The live run panel appears above the editor. Press `←` from an empty editor,
or `Ctrl+Q`, to focus it. Select an agent and press `Enter` to attach.

### Talk to a running agent

Attaching opens the agent's live transcript and a dedicated editor. Your
messages join the existing delegated session; they do not start a new agent.
If a tool is running, the message waits until the current tool-call batch
finishes.

While attached:

- Press `Enter` to send a message.
- Press `Esc` to interrupt the current turn.
- Press `←` from an empty editor to return to the parent session.
- Press `Shift+↑` or `Shift+↓` to scroll the transcript.

An interrupted built-in shell command is cancelled immediately. Other tools
must support cancellation. The delegated session remains alive after an
interrupt, so you can send another instruction.

Result submission is deferred while you are attached. When you leave, an idle
agent finishes its assignment and submits its workflow result. Conversation
messages are not substituted for that result unless you explicitly instruct
the agent to use their content.

Attaching to a settled agent opens its saved Pi session. Switching sessions
stops active workflows, so Pi asks for confirmation when necessary.

### Optional footer counters

When
[pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
pi-agents can show `❖N` for active workflows and `✦A/T` for completed and total
agents. Enable the `workflows` and `agents` widgets through `/fancy-footer`.
Both are disabled by default.

## ⚙️ Configuration

### Model guidance

The planning agent picks a model for every node, and by default it only sees
a bare list of model IDs. So it plays it safe. Every branch of a ten-way
fan-out runs on the session model, usually your most capable and most
expensive one. A review that should spend a premium model on the final merge
and cheap fast models on the mechanical branches spends premium everywhere.

Two things narrow this gap.

1. **Automatic price tiers.** The planning prompt marks every model with `$`,
   `$$`, or `$$$`, derived from list prices, and tells the planner to prefer
   `$` for mechanical subtasks and `$$$` for planning, review, and reduces.
   Tiers describe spend, not quality. For subscription providers they
   indicate relative quota use. This needs no configuration.
2. **Your fit notes.** Price alone cannot say what a model is *for*. If
   flash-class models handle your triage well, or one model writes your best
   reviews, teach the planner once in `~/.pi/agent/workflows.json` instead
   of repeating it in every request:

```json
{
  "models": {
    "google/gemini-*-flash*": "fast triage, summaries, extraction",
    "claude-opus-*": "planning, reduces, final review"
  }
}
```

With these notes, "review this PR with parallel lenses" yields a plan whose
fan-out branches run on flash-class models and whose merging reduce runs on
Opus. You never name a model in the request.

Patterns match provider-qualified model IDs. A pattern without `/` matches
any provider, and `*` is the only wildcard. The match with the longest
literal prefix wins; a trusted project's `.pi/workflows.json` wins a tie with
the user configuration. Pi-agents ignores project model notes until you trust
the project, because notes flow into the planning prompt.

To check what the planner chose, read the workflow tree. Static trees attach
`@model` where a node pins a model directly. Live run rows and trees show the
planned or effective model for every agent. A node without `@model` in a
static tree does not imply the session default, since an agent profile may
pin a model.

### Bundled workflows

A user or project workflow named `review` overrides the bundled workflow.

Disable all bundled workflows in `~/.pi/agent/workflows.json`:

```json
{
  "bundledWorkflows": false
}
```

Control them individually:

```json
{
  "bundledWorkflows": {
    "review": false
  }
}
```

A trusted project can use `.pi/workflows.json`. Project settings override user
settings.

### Event-triggered workflows

A saved workflow can run after a Pi event:

```yaml
name: after-turn
on: [turn_end]
debounce: 1000
task: "Inspect this event: {params.event}"
```

Event workflows always run in the background.

### Project trust

Pi-agents follows Pi's project-trust decision. Until you trust a project,
project-local profiles, workflows, and skills remain unavailable. User-level
resources continue to work.

### Run history

Run history belongs to the originating Pi session and survives reloads. After
a Pi restart, pi-agents marks unfinished runs as stopped because delegated
processes cannot resume. Completed history remains available through
`/workflows`.

## 🔌 Extension integration

Other Pi extensions can start runs and observe lifecycle events through the
typed `pi-agents/api` client:

```ts
import { createPiAgentsClient } from "pi-agents/api";

const agents = createPiAgentsClient(pi, { caller: "my-extension" });

const stopListening = agents.onRunEvent((event) => {
  if (event.type === "run_completed") {
    console.log(event.status);
  }
});

const { runId } = await agents.start({
  workflow: "review",
  params: { target: "src" },
  display: "report",
});

await agents.stop(runId);
stopListening();
```

The client supports `start`, `stop`, `list`, and `onRunEvent`. A successful
`start` response may include `warnings` for recoverable request problems. Runs
started by extensions obey the current session's budgets, resource scope, and
project trust settings.

## 🧰 Requirements

Pi-agents follows the latest Pi release. Keep Pi updated:

```sh
pi update pi
```

The `pi` executable must be available on `PATH` for delegated agents.

## 🩺 Troubleshooting

- Open `/workflows` to view invalid workflow diagnostics and failed runs.
- Check profile, workflow, and skill names when validation fails before a run
  starts.
- Update Pi if a delegated process reports an initialization error.
- Use `/workflow <id> agents` to identify the delegated agent that failed.
- Open a settled agent with `/agent-session <run-id> [node]` when you need its
  complete conversation and tool history.

## 📄 License

Apache-2.0
