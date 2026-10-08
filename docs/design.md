# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. This document describes the 1.0 design and its first form of
composition: groups of agents that report back together.

## Principles

- The agent is the core abstraction. An agent's result is its last assistant
  message. A group composes agents without changing them.
- pi-durable is the substrate. We do not run agents as Pi processes.
- The parent conversation stays primary. Agents appear as compact lines, tool
  calls, and result messages.
- The frontend depends on `AgentService` only, never on pi-durable types.

## Core abstractions

| Abstraction | Meaning | Backed by |
| --- | --- | --- |
| Host | One pi-durable `Harness` per parent Pi session | JSONL storage in `~/.pi/agent/pi-agents/<session-id>/` |
| Agent | A durable, named conversation | An ownerless conversation, or one a turn owns, plus an `AgentRecord` |
| AgentRecord | Name, profile, creation time, closed flag, parent requests, group | The session document `pi-agents.agents` |
| Group | Named agents that work in parallel and report back as one result | A group task plus a `GroupRecord` |
| GroupRecord | Name, policy, creation time, agents, turns, closed flag, whether the parent still expects the result | The session document `pi-agents.groups` |
| Group turn | One group agent's task: one message and its answer | A turn task |
| Turn | One input and the work until its final answer | A pi-durable input submission |
| Result | The last assistant message: text, stop reason, entry ID | The turn's assistant entry |
| Parent request | A turn the parent model started through `spawn` or `send` | An outbox entry in the record plus a submission with the same request ID |
| Profile | Reusable spawn defaults | `.pi/agents/*.md` and `~/.pi/agent/agents/*.md` |
| AgentService | The API for tools and UI | Wraps the Host |

Agent states are derived, never stored:

- `working`: the conversation has a run (`pi.live.run`).
- `interrupted`: the last answer was aborted.
- `failed`: the last answer ended with an error.
- `idle`: otherwise.

`closed` is a flag that hides an idle agent from the panel; storage keeps it.
Users and models call this *stopping* an agent. An agent closes on its own
once an answer to a parent request is delivered or consumed by a wait and no
parent request remains. Failed and interrupted agents stay open. A parent message to a closed agent opens it again. A closed agent
that works again, for example because the user talks to it, shows in the
panel until it is idle. Names are unique among
visible agents; a name resolves to the visible agent first, then to the newest
closed one.

## Lifecycle

- `spawn` creates the conversation and its record in one commit, then sends
  the task. Settings resolve as profile, then spawn arguments, then the parent
  session's model and thinking level.
- `send` prompts an idle agent and steers a working one; `followUp` queues
  after the current answer instead.
- `wait` resolves once the named agents are idle and returns their results.
  Cancelling a wait cancels only the wait.
- `interrupt` aborts the current work; the agent stays open. Only the attach
  view's Esc interrupts.
- `stop` interrupts, drops pending parent requests, and closes the agent. The
  UI asks for confirmation while the agent works.
- Agents cannot spawn agents.

## Groups

A group runs on pi-durable's tasks and ownership tree, so its bookkeeping is
durable and cancellable without hand-written state machines.

### Tasks

The extension `pi-agents-groups` registers two tasks in the harness registry.
Agents never select it; tasks resolve their definitions from the registry.

- `pi-agents.turn` (version 1) has one phase. It finds its agent's
  conversation through the ownership index, submits the task with request ID
  `turn:<task-id>`, waits for the submission, and commits its outcome:
  `completed` with the answer entry, `completed` as interrupted when the agent
  itself was interrupted or stopped, `failed` on a model error, or `aborted`
  from its abort handler when the group stopped it.
- `pi-agents.group` (version 1) reads its turns from its `GroupRecord` in
  phase `join` and commits `waiting` on them with `allSettled` or `failFast`.
  Phase `report` reads their outcomes and completes. Its abort handler
  commits `aborted`.

### Ownership

```text
host conversation (the harness root; never runs)
└─ group task             background, owned by the conversation
   └─ turn task × n       owned by the group
      └─ agent conversation   owned by its turn
         └─ pi.generation, pi.tool
```

`AgentService.spawnGroup` creates the group, its turns, the agent
conversations, their `AgentRecord`s, and the `GroupRecord` in one commit.
Names, tools, and thinking levels are validated before it, so a group starts
whole or not at all. Then:

- The group task is a background task, so nothing on the host conversation
  reaches it, and it never blocks idle waits of standalone agents.
- Conversations hang below their turns, not below the group. `failFast` marks
  the sibling turns of a failed one, and the abort cascade reaches their
  agents' runs.
- Stopping a group is `abortTask` on the group. Abort runs bottom-up: the
  agents' runs, then the turns' abort handlers, then the group's.
- A turn finishes only once its agent's work drained, and the group only once
  its turns did. A follow-up queued to a group agent therefore holds back the
  group's result until the agent answered it.
- Interrupting or stopping one agent settles its submission as aborted. Its
  turn completes as interrupted rather than failing, so `failFast` keeps the
  other agents working.
- Agents outlive their group. Once a turn is terminal, new work in its
  agent's conversation is ordinary work: the user can attach, and the parent
  can message the agent like any other.

A group agent has no parent request for its task; its turn sends it. A group
agent counts as working from its spawn until its turn ended. Groups and
standalone agents share one name space among visible agents and groups.

### Restart

Closing the harness preserves every task. On reopen, the waiting group stays
waiting, finished turns stay terminal and never run again, and a running turn
reruns its phase: its request ID finds the submission it already made, and it
waits for it while pi-durable resumes the agent's run. The group then reports
once, and its result delivers once.

### Versions and migration

Both tasks and both documents are at version 1. A later change to a task's
input or checkpoint bumps its `version` and adds `migrate(input, checkpoint,
fromVersion)`; pi-durable migrates a live task atomically when it next
reserves it. A migration must keep the group's `turns`. Terminal tasks are
stored results and never migrate. A task whose definition is missing or older
than the stored one stays blocked rather than lost; stopping its group then
settles it as `orphaned`. Documents migrate the same way through
`defineDoc`'s `migrate`, applied on their next access. The new optional
`AgentRecord.group` field needed no migration.

## Delivery

Parent requests use an outbox for exactly-once submission: the record stores
the request ID and message first, then the submission follows with the same
request ID. On open, the Host resubmits outbox entries without a submission;
the request ID makes this idempotent.

When a parent request settles:

1. If a `wait` covers the agent, the wait consumes the result.
2. Otherwise the result is posted into the parent as a `pi-agents:result`
   message. It starts a parent turn when the parent is idle and waits for idle
   otherwise. Delivery also waits while the user is attached to an agent.
3. Aborted requests deliver nothing.
4. Several requests answered by the same entry deliver once.

A group delivers one `pi-agents:group-result` message with each agent's
outcome: its answer, its failure, or that it was interrupted or stopped. The
answer is the one to the group's task, even if the agent answered later
messages since. The `GroupRecord`'s `pending` flag is the outbox:

1. A wait on the group consumes the result instead.
2. A stopped group delivers nothing.
3. While the result is pending, the group's agents deliver nothing of their
   own. Acknowledging the group marks the agents' answers delivered, so a
   parent message answered by the same entry delivers with the group, and a
   later answer delivers on its own.
4. The group closes on delivery, and so do its agents that answered or that
   the group stopped. Failed and interrupted agents stay open.

Turns the user starts from the attach view never deliver into the parent.
Delivery is acknowledged after posting, so a crash can repeat a delivery but
never lose one. On session resume, unacknowledged settled requests deliver.

## Durability

- Quitting or crashing Pi pauses agents. Resuming the session with `pi -c`
  reopens the Host, resumes interrupted work, and delivers pending results.
- Switching sessions pauses that session's agents until the user returns.
- A lock file gives one Pi process ownership of a session's agents. Another
  process shows a notice and runs without agents.

## Agent runtime

- Tools: `read`, `write`, `edit`, and `bash` from pi-durable, plus `grep`,
  `find`, and `ls` adapted from Pi's tool definitions. The default set is Pi's:
  `read`, `bash`, `edit`, `write`.
- System prompt: a delegation preamble, tool guidelines, context files such as
  `AGENTS.md`, skills, the working directory and date, and profile
  instructions.
- Models: the parent session's model runtime, so logins and custom providers
  work.
- Settings: compaction, retry, and queue modes come from Pi's settings.
- No MCP and no extension tools yet.

## Parent tools

| Tool | Parameters |
| --- | --- |
| `agent_spawn` | `task`, `name?`, `profile?`, `model?`, `thinking?`, `tools?`, `cwd?`, `wait?` (seconds) |
| `agent_spawn_group` | `name?`, `agents` (2 to 8 of `task`, `name?`, `profile?`, `model?`, `thinking?`, `tools?`, `cwd?`), `failFast?`, `wait?` (seconds) |
| `agent_send` | `name`, `message`, `followUp?`, `wait?` (seconds) |
| `agent_wait` | `names` (agents or groups), `timeout?` |
| `agent_status` | `name?` (agent or group) |
| `agent_stop` | `name` (agent or group) |

`agent_spawn_group` is a separate tool rather than an `agents` argument of
`agent_spawn`, because "either `task` or `agents`" cannot be expressed in the
tool schemas that providers accept. Group agents without a name are called
`<group>-<n>`, or after their profile. `agent_send` to a group fails and
lists its agents.

The system prompt adds one line of guidance, the usable profiles, and the
user's scoped models (`ctx.scopedModels`, from `/scoped-models` or `--models`)
so the parent recognizes model names. Profiles and models are XML elements
whose attributes carry details: a model's ID, name, context window, cost per
million input/output tokens, and pinned thinking level. It lists no other
models. The `model` argument and profile models resolve like `pi --model`
patterns among models with credentials: exact `provider/id` or `id` first,
then the newest alias that partially matches. Choosing models per task is left to a future model router. Profiles
with an unavailable model or unresolvable skills stay
out of the prompt, and the UI reports them once per session. Each tool call
renders its explicit arguments as a dim `key=value` line.

## Frontend

- Panel above the editor: one line per open agent or group, working first,
  idle ones always shown. A group's line shows how many of its agents
  finished, with its agents indented below it; unfocused, a finished group
  folds to its line. Left arrow from an empty editor or Ctrl+Q focuses it; ↑↓
  select, ⏎ attaches (a group: its first agent), `s` stops an agent or a
  group, and Esc returns. While the stop confirmation is open, keys go to
  the confirmation. The glyph carries the state; working agents show how long
  they have worked.
- Attach view: a port of Pi's `ExperimentalChatView`, rendering the agent's
  durable conversation view with Pi's message and tool components. ⏎ prompts
  or steers, Alt+⏎ queues a follow-up, Esc interrupts, ← detaches, Shift+↑↓
  scrolls.
- `/agents`: a table of all agents and groups, a group's agents below it,
  closed ones dimmed, with details, attach, and stop. `/agent <name>`
  attaches.
- Result messages render the agent, its state, and the result as Markdown. A
  group's message renders each agent's line and result.
- The task graph stays out of the UI: group and agent states already say what
  users need. `AgentService.liveTasks()` exposes it for tests and debugging.
- The fancy-footer integration reports working and idle counts.

## Testing

Tests use pi-durable's memory storage and pi-ai's faux provider. Restart tests
use JSONL storage: interrupt a turn, close, reopen, and verify that the turn
completes and its result delivers once. Group tests cover `allSettled` with
answers and failures, `failFast`, stopping a group, the ownership tree through
the task graph, a restart mid-group that repeats no finished turn and sends no
task twice, and messaging a group's agent after the group finished.

## Deferred

Composition beyond groups (result schemas, merge steps, pipelines), budgets,
MCP, extension tools, nested agents, forking agents, a daemon or CLI, agents
shared across sessions, and model changes for running agents.
