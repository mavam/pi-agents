# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. This document describes the 1.0 design and its first form of
composition: graphs of agents that pass results to each other.

## Principles

- The agent is the core abstraction. An agent's result is its last assistant
  message. A graph composes agents without changing them.
- pi-durable is the substrate. We do not run agents as Pi processes.
- The parent conversation stays primary. Agents appear as compact lines, tool
  calls, and result messages.
- The frontend depends on `AgentService` only, never on pi-durable types.
- The host owns the harness. The core runs on whatever harness and anchor
  its host hands it, so it can later run inside Pi's durable session worker
  with a different host and the same core.

## Core abstractions

| Abstraction | Meaning | Backed by |
| --- | --- | --- |
| Host | Owns the storage, its lock, and one pi-durable `Harness` per parent Pi session | JSONL storage in `~/.pi/agent/pi-agents/sessions/<session-id>/` |
| Anchor | The conversation that owns the graphs the parent starts | Chosen by the host; inside Pi the harness's root conversation, which never runs |
| Agent | A durable, named conversation | An ownerless conversation, or one a turn owns, plus an `AgentRecord` |
| AgentRecord | Name, profile, creation time, closed flag, parent requests, graph | The session document `pi-agents.agents` |
| Graph | Named agents plus edges that carry results; reports back as one result | A graph task plus a `GraphRecord` |
| GraphRecord | Name, policy, creation time, nodes (agent, node task, inputs), closed flag, whether the parent still expects the result | The session document `pi-agents.graphs` |
| Node | One graph agent's task: wait for its inputs, then one message and its answer | A node task |
| Edge | `A → B`: B starts once A finished and receives A's final message | A node's `after` list |
| Turn | One input and the work until its final answer | A pi-durable input submission |
| Result | The last assistant message: text, stop reason, entry ID | The turn's assistant entry |
| Parent request | A turn the parent model started through `spawn` or `send` | An outbox entry in the record plus a submission with the same request ID |
| Profile | Reusable spawn defaults | `<cwd>/.pi/agents/*.md` and `~/.pi/agent/agents/*.md` |
| AgentService | The core: the API for tools and UI | Runs on the harness and anchor the host hands it |

## Structure

pi-agents mirrors the split of Pi's durable session worker
(`packages/coding-agent/src/experimental/` in Pi's repository), which opens
the store and the harness and hands harness, conversation, models, and
settings to the parts that need them:

- **Host** (`src/host`, and `SessionHost` in `src/pi/session.ts`): takes the
  session's lock, opens its storage and the harness with pi-agents'
  extensions installed (`openAgentHarness`), and chooses the anchor. Inside
  Pi the anchor is the root conversation, which sessions stored by earlier
  versions already anchor their graphs on. The host closes the harness after
  the core.
- **Core** (`src/agents`): `AgentService` and pi-agents' pi-durable
  extensions. `createAgentExtensions` returns the tools, the prompt, the
  graph tasks, and delegation; `installAgentExtensions` installs them in any
  registry, the way the session worker installs `CodingTools` and its
  prompt, and `agentSelection` is the default selection of agents.
  `AgentService.start` takes the harness, the anchor, and the extensions.
  The core never opens storage or a harness, never closes them, and never
  assumes the root conversation.
- **Frontend** (`src/pi`, `src/ui`): tools, commands, and views. They see
  plain data through `AgentService`, like the session worker's presentations
  see `AgentController` and `Transcript`; only the attach view reads a
  conversation's view.

A durable Pi would host pi-agents in its session worker: install the
extensions in the worker's registry and pass its harness and the session's
main conversation as the anchor.

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
closed one. Every creation claims its names inside its creating commit,
against the durable records, so agents started at once can't share a name.

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
- Agents start other agents only when they may delegate (see "Agents that
  delegate"); helpers never do.

## Graphs

A graph runs on pi-durable's tasks and ownership tree, so its bookkeeping is
durable and cancellable without hand-written state machines.

### Model

A graph is agents plus edges. An edge `A → B` means B starts once A finished
and receives A's final message, appended to its task under "Results of other
agents". The agents nothing waits for are the graph's end nodes; their
results are the graph's result. A graph without edges reports every agent's
result; a merging agent after all others makes the graph's result that
agent's answer. There is no language: no references, schemas, loops, or
conditions. Edges only carry final messages.

### Tasks

The extension `pi-agents-graphs` registers two tasks in the harness registry.
Agents never select it; tasks resolve their definitions from the registry.

- `pi-agents.node` (version 1) has two phases.
  - `wait` reads the node's inputs from its `GraphRecord` and commits
    `waiting` on their node tasks with `allSettled`, the only policy pi-durable
    allows for tasks a task doesn't own. A node without inputs goes straight
    to `run`.
  - `run` builds the message from the task and the inputs' stored answers.
    When no input answered, it completes as skipped. Otherwise it finds its
    agent's conversation through the ownership index, submits with request ID
    `node:<task-id>`, waits for the submission, and commits its outcome:
    `completed` with the answer entry, `completed` as interrupted when the
    agent itself was interrupted or stopped, `failed` on a model error, or
    `aborted` from its abort handler when the graph stopped it.
- `pi-agents.graph` (version 1) reads its nodes from its `GraphRecord` in
  phase `join` and commits `waiting` on all of them with `allSettled` or
  `failFast`. Phase `report` reads their outcomes and completes. Its abort
  handler commits `aborted`.

### Ownership

```text
anchor (inside Pi the harness root; never runs)
└─ graph task             background, owned by the conversation
   └─ node task × n       owned by the graph
      └─ agent conversation   owned by its node
         └─ pi.generation, pi.tool
```

`AgentService.spawnGraph` creates the graph, its nodes, the agent
conversations, their `AgentRecord`s, and the `GraphRecord` in one commit.
Names, tools, thinking levels, and edges are validated before it: `after`
must name agents of the same graph, an agent can't wait for itself, and the
edges form no cycle. A graph starts whole or not at all. Then:

- The graph task is a background task, so nothing on the anchor
  reaches it, and it never blocks idle waits of standalone agents.
- Conversations hang below their nodes, not below the graph. `failFast` marks
  every other live node, including nodes still waiting for inputs, and the
  abort cascade reaches their agents' runs. Such nodes end as stopped, not
  skipped.
- Stopping a graph is `abortTask` on the graph. Abort runs bottom-up: the
  agents' runs, then the nodes' abort handlers, then the graph's.
- A node finishes only once its agent's work drained, and the graph only once
  its nodes did. A follow-up queued to a graph agent therefore holds back the
  graph until the agent answered it. pi-durable holds the decided outcome
  (`completing`) meanwhile; the service counts a graph as working until its
  task is terminal, and records a stop as `GraphRecord.stopped`, because a
  held `completed` outcome can't become `aborted`.
- A node waits until all its inputs finished, even when one already failed.
- Interrupting or stopping one agent settles its submission as aborted. Its
  node completes as interrupted rather than failing, so `failFast` keeps the
  other agents working, and nodes after it still run with the others'
  results.
- Agents outlive their graph. Once a node is terminal, new work in its
  agent's conversation is ordinary work: the user can attach, and the parent
  can message the agent like any other.

A graph agent has no parent request for its task; its node sends it. A graph
agent counts as waiting while an input's node is live, then as working until
its own node ended. Graphs and standalone agents share one name space among
visible agents and graphs.

### Restart

Closing the harness preserves every task. On reopen, waiting nodes and the
waiting graph stay waiting, finished nodes stay terminal and never run again,
and a running node reruns its phase. It builds the same message from stored
answers and names, and its request ID finds the submission it already made,
so the agent gets its task once while pi-durable resumes its run. These
guarantees cover admission: a model call or tool effect that was in flight at
the crash can run again, and delivery to Pi stays at least once.

### Versions and migration

Both tasks and both documents are at version 1. A later change to a task's
input or checkpoint bumps its `version` and adds `migrate(input, checkpoint,
fromVersion)`; pi-durable migrates a live task atomically when it next
reserves it. A migration must keep the task IDs in the checkpoints (a node's
`inputs`, the graph's `nodes`). Terminal tasks are stored results and never
migrate. A task whose definition is missing or older than the stored one
stays blocked rather than lost; stopping its graph then settles it as
`orphaned`. Documents migrate the same way through `defineDoc`'s `migrate`,
applied on their next access. The new optional `AgentRecord.graph` field
needed no migration.

### Agents that delegate

An agent with `delegate` splits its own task at runtime: it starts a graph of
helpers, waits for it, and continues with its result in the same run. This
covers map, fan-out over what the agent discovers, and nested workflows,
without a language.

The extension `pi-agents-delegation` holds one pi-durable tool,
`delegate_graph` (`replay: "safe"`), with the shape of `agent_spawn_graph`
minus `wait`: 1 to 12 helpers with `after` edges, and `failFast`. The call
blocks and returns the graph's result as the tool result, the same text Pi
gets for its graphs, within a budget below pi-durable's tool output limit.

```text
delegating agent's conversation
└─ pi.generation → pi.tool (delegate_graph)
   └─ graph task          owned by the tool task; not background
      └─ node task × n
         └─ helper conversation
```

- The tool task owns the graph task, so the graph belongs to the agent's run.
  Esc on the agent aborts the tool and, bottom-up, the helpers; stopping a
  graph the agent belongs to reaches them through the agent's conversation.
  Stopping only the helpers by name ends the call with a "stopped" result,
  and the agent goes on.
- A restart reruns the call. It finds the graph its tool task owns, through
  `GraphRecord.owner.tool`, before resolving anything again, and waits for
  it. Finished helpers don't rerun, and no helper gets its task twice.
- Capability: the registry installs the extension, but only delegating agents
  select it and its tool; `AgentRecord.delegate` stores the choice, and the
  tool refuses agents whose record doesn't allow it or that are helpers.
  pi-durable copies an owner task's conversation's agent settings into the
  conversations it owns, so every helper is configured explicitly: no
  delegation extension, its own tools, model, thinking level, instructions,
  and working directory. Depth is therefore 2.
- Helpers get only tools their agent has. Profiles, models, and skills
  resolve like Pi's spawns through the `HelperResolver` the session host
  provides, with the agent's model, thinking level, and working directory as
  defaults. It takes and returns plain data. A helper's skills come from its
  own profile or request, never from its agent's.
- Names: helpers are `<agent>.<name>` and their graph `<agent>.<name or
  helpers>`, shortening the agent's part to fit and claimed in the creating
  commit like all names. The tree, the graph detail, and the agent's
  `delegating` activity drop the agent's part while the helpers sit below
  it; the divider in `/agents`, the attach view, and everything the parent
  model reads keep full names, which address them.
- Limits, fixed: 12 helpers per call, 24 per agent over its lifetime, and 16
  helpers working at once across the session. A call over a limit returns an
  error result the agent can act on; the checks run in the creating commit,
  after the rerun lookup, so a rerun never counts twice.
- Delivery: the graph's record has `pending: false`, because the tool result
  is its delivery; Pi's outbox isn't involved. Once the call ended, by its
  result or an interrupt, the service closes the graph and its helpers, so
  they leave the panel; storage and `/agents` keep them.
- While the agent waits, Pi-style steering reaches it only after the call
  ends. The attach view says so, and Esc stops the helpers.

## Delivery

Parent requests use an outbox for exactly-once submission: the record stores
the request ID and message first, then the submission follows with the same
request ID. When the service starts, it resubmits outbox entries without a
submission; the request ID makes this idempotent.

When a parent request settles:

1. If a `wait` covers the agent, the wait consumes the result.
2. Otherwise the result is posted into the parent as a `pi-agents:result`
   message. It starts a parent turn when the parent is idle and waits for idle
   otherwise. Delivery also waits while the user is attached to an agent.
3. Aborted requests deliver nothing.
4. Several requests answered by the same entry deliver once.

A graph delivers one `pi-agents:graph-result` message with the outcomes of
its end nodes: an answer, a failure, or that the node was interrupted,
stopped, or skipped. With one end node, the message reads as that agent's
answer (`Graph review: merge answered: …`). Agents in between that didn't
answer are named after it, so the parent sees why a merge is partial. A
node's answer is the one to its graph task, even if the agent answered later
messages since. The `GraphRecord`'s `pending` flag is the outbox:

1. A wait on the graph consumes the result instead.
2. A stopped graph delivers nothing.
3. While the result is pending, the graph's agents deliver nothing of their
   own. Acknowledging the graph marks the agents' answers delivered, so a
   parent message answered by the same entry delivers with the graph, and a
   later answer delivers on its own.
4. The graph closes on delivery, and so do its agents that answered, were
   skipped, or that the graph stopped. Failed and interrupted agents stay
   open.

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
  `read`, `bash`, `edit`, `write`. Delegating agents also get
  `delegate_graph`.
- System prompt: a delegation preamble, tool guidelines, context files such as
  `AGENTS.md`, skills, the working directory and date, and profile
  instructions.
- Profiles: `.pi/agents` of the agent's working directory, the `.pi` Pi
  reads project skills and settings from, so a project profile and the
  project skills it names always come from the same project. Untrusted
  projects contribute none.
- Skills: `SkillCatalog` (`src/catalog/skills.ts`) resolves them with Pi's
  package manager and settings for the agent's directory and the project's
  trust, so agents find what Pi finds: `~/.pi/agent/skills`,
  `~/.agents/skills`, packages, the `skills` setting with its overrides, and
  the project's `.pi/skills` and `.agents/skills`. An untrusted project
  contributes none, but the user's skills remain. Resolution skips packages
  that aren't installed instead of installing them, and loads once per
  directory and trust, like Pi at startup; `/reload` starts a fresh catalog.
  Session-only resources don't reach agents: `--skill` paths, packages from
  `-e`, skills extensions add, and `--no-skills`. Packages that npm resolves
  globally may run `npm root -g` once per catalog load. An agent sees them as
  a catalog unless a profile or the spawn names skills
  (`AgentRecord.ambientSkills`):
  a named list inlines those skills in the instructions and turns the
  catalog off, and an empty list means none. The spawn's list replaces the
  profile's. Pi's catalog hides skills marked `disable-model-invocation`,
  and so does the agents'. Because a model chooses the spawn's and helpers'
  lists, those reject such skills; only the user names them, in a profile.
  An unknown or unreadable skill fails the spawn, and a graph or helper set
  resolves all of its agents before any starts.
- Models: the parent session's model runtime, so logins and custom providers
  work.
- Settings: compaction, retry, and queue modes come from Pi's settings.
- Request limit: `piAgents.maxConcurrentRequests` in Pi's settings caps the
  model requests the session's agents make at once, for model servers that
  serve one request at a time. The Host wraps the `Models` it gives the
  harness, whose `streamSimple` and `completeSimple` carry every generation
  and compaction request; a request over the cap waits in a FIFO line before
  it reaches the provider, and an abort while it waits ends it as aborted.
  Agents, graph nodes, and helpers all go through it; tools still run in
  parallel, and the parent session's own requests don't count. The line is
  in memory: a resumed run asks again. Unlike the delegation limits, which
  refuse helpers, it never refuses work: agents only wait their turn and
  stay `working` meanwhile. Read when the Host opens; absent or invalid means
  no limit, and an invalid value shows a warning.
- No MCP and no extension tools yet.

## Parent tools

| Tool | Parameters |
| --- | --- |
| `agent_spawn` | `task`, `name?`, `profile?`, `model?`, `thinking?`, `tools?`, `skills?`, `cwd?`, `delegate?`, `wait?` (seconds) |
| `agent_spawn_graph` | `name?`, `agents` (2 to 12 of `task`, `name?`, `after?`, `profile?`, `model?`, `thinking?`, `tools?`, `skills?`, `cwd?`, `delegate?`), `failFast?`, `wait?` (seconds) |
| `agent_send` | `name`, `message`, `followUp?`, `wait?` (seconds) |
| `agent_wait` | `names` (agents or graphs), `timeout?` |
| `agent_status` | `name?` (agent or graph) |
| `agent_stop` | `name` (agent or graph) |

`agent_spawn_graph` is a separate tool rather than an `agents` argument of
`agent_spawn`, because "either `task` or `agents`" cannot be expressed in the
tool schemas that providers accept. Its description nudges the model to add a
merging agent after the others when it wants one answer. `after` names
agents of the same graph; agents without a name are called `<graph>-<n>`, or
after their profile. The spawn result names the graph's shape, such as
`{api, tests} → merge`. `agent_send` to a graph fails and lists its agents.

Each tool also declares an output schema and returns structured content,
which codemode scripts receive instead of the text (`src/pi/output.ts`):

| Tool | Output |
| --- | --- |
| `agent_spawn`, `agent_send` | the agent |
| `agent_spawn_graph` | the graph |
| `agent_wait` | `agents`, `graphs`, and `pending`: the names the wait ended before |
| `agent_status` | `agents` and `graphs` |
| `agent_stop` | `kind`, `name`, and `state` of what stopped |

An agent is its `name`, `state`, `graph`, and what its latest turn
produced: `result` when it answered or wrote something before it was
interrupted, `error` when it failed, and nothing while it works or waits.
A turn never reports an earlier turn's answer: the service records the
first input entry of a turn that ended without an answer
(`AgentInfo.unanswered`), and a result older than it belongs to an earlier
turn. A failed turn without an error message reports pi-durable's reason,
such as `no_model`. The text that waits return follows the same rule.

A graph is its `state`, `stopped`, and per agent its `after`, `end`, and
`outcome`, which is how its task ended or that it still works or waits,
with `result` or `error`. Nodes carry the answer to the graph's task, not
later replies of the agent. Results keep the limit of the text the model
reads and say when they were cut with `truncated`. Objects have exactly
their declared fields. The output names facts scripts act on; IDs, models,
usage, and activity stay in the text and the UI's details. `agent_stop`
returns only what stopped, which keeps its declaration short. Calls that
wait return what they observed after the wait: a timeout or a steer can
leave an agent `working` or `waiting`, and only `agent_wait` lists the
names it didn't finish waiting for in `pending`.

Models sometimes pass `wait: false` or quoted numbers, so the tools drop
seconds that aren't positive numbers and parse numeric strings before
validation.

Pi places a user's steering message only after the current tool round. A
wait would therefore hold a steer back until the agents answer, so a steer
ends every running wait at once; the agents keep working and their results
arrive as messages. Follow-ups don't end waits.

The system prompt adds one line of guidance, the usable profiles, and the
user's scoped models (`ctx.scopedModels`, from `/scoped-models` or `--models`)
so the parent recognizes model names. Profiles and models are XML elements
whose attributes carry details: a profile's model, thinking level, tools, and
skills, and a model's ID, name, context window, cost per million input/output
tokens, and pinned thinking level. It lists no other
models. The `model` argument and profile models resolve like `pi --model`
patterns among models with credentials: exact `provider/id` or `id` first,
then the newest alias that partially matches. Choosing models per task is left to a future model router. Profiles
with an unavailable model or unresolvable skills stay
out of the prompt, and the UI reports them once per session. Each tool call
renders its explicit arguments as a dim `key=value` line. A call that starts
a graph draws the graph right below its title, with inputs and models but
without glyphs, times, or usage, which would only describe the moment of the
call; the panel shows the live state. That holds while a call waits, too:
its progress carries what it started and draws no states, so the call
doesn't repeat the panel. The result renderer stores what started in the
renderers' shared state, and the call reads it when it draws. Every final
result resets it, so a replay, which has no progress, draws the same: an
outcome or an error drops what started, and a call that only started work
sets it again. A started agent adds nothing to its call. Expanded, a call
shows its arguments and tasks in full, one paragraph per agent, wrapped
under their indentation. Calls that report outcomes show the agents'
states. A failed call shows its error text in the error color instead: Pi
marks a call failed without agent details when the tool throws or when the
model's message broke off before Pi ran it.

## Frontend

- Panel above the editor: one line per open agent or graph, working first,
  idle ones always shown. A graph's line shows how many of its agents
  finished, with its agents below it as a tree in stages, each with `←` and
  the agents it receives results from; unfocused, a finished graph
  folds to its line. Left arrow from an empty editor or Ctrl+Q focuses it,
  or opens `/agents` while it's empty; ↑↓
  select, space folds a graph or an agent's helpers (on a row inside one, the
  row it sits in), ⏎ attaches (a graph: its first agent), `s` stops an agent
  or a graph, Tab opens `/agents` at the same row, and Esc returns. Tab in
  `/agents` returns to the panel at the same row while the panel shows agents;
  its footer only offers it then. A folded row says how many agents it hides.
  The panel and `/agents` share what the user folded, which wins over
  folding finished graphs. While the stop confirmation is open, keys go to
  the confirmation. The glyph carries the state; working agents show how long
  ago they started, idle pauses and waits for inputs included; finished rows
  show no time. Delivery waits while the parent works or the user is
  attached, so an idle agent with an undelivered answer to a parent request
  shows `●` in the accent color rather than green and `result queued`, as
  does a finished graph whose result is pending; a failed one keeps its red
  glyph and adds the note. `/agents` rows and details and the attach view's
  header carry the note too. Glyphs elsewhere describe outcomes, not
  delivery: a graph's agents keep their glyphs while the graph line carries
  the note, answers to the user never deliver, and the footer counts queued
  agents as idle. `AgentInfo.queued` and `GraphInfo.queued` hold the flag.
- Attach view: a port of Pi's `ExperimentalChatView`, rendering the agent's
  durable conversation view with Pi's message and tool components. ⏎ prompts
  or steers, Alt+⏎ queues a follow-up, Esc interrupts, ← detaches, Shift+↑↓
  scrolls.
- `/agents`: a table of all agents and graphs, a graph's agents below it,
  closed ones dimmed, with details, attach, and stop. Each row shows how
  long it ran: from its creation until now while it works or waits, else
  until it ended. An agent ended when its latest generation task became
  terminal, or with its node if it never ran; a graph when its task did.
  These durable `endedAt` times survive restarts and later messages to a
  graph's agents; a resumed agent's time jumps forward, pause included. `/agent <name>`
  attaches. Tasks and results in its detail pane render as Markdown. An agent's detail
  separates its task and its latest result (or error) with dividers like the
  one under the table, each naming its section: "Result" while the answer
  replies to the task, "Latest result" once the agent answered later
  messages. An agent never ends for good, since a message reopens it, so
  there is no "final" result. A graph's detail says its
  order in words when it has edges ("Runs map, then api and tests at once,
  then merge."), then each agent under a heading with its glyph, name, and
  spend, and its result below; only ⊘, which covers stopped and interrupted,
  adds a word.
- Result messages render the agent, its state, and the result as Markdown. A
  graph's message renders its end agents' results and names the agents in
  between that didn't answer.
- Graphs reuse the look of the earlier workflow trees (status glyphs, `├─`
  connectors) but not their code, which was bound to the workflow language.
  `○` marks an agent waiting for inputs and `⊖` a skipped one.
- pi-durable's task graph stays out of the UI: graph and agent states say what
  users need. `AgentService.liveTasks()` exposes it for tests and debugging.
- The fancy-footer integration reports working and idle counts.

## Testing

Tests use pi-durable's memory storage and pi-ai's faux provider, and open
the harness through the same host function as Pi. A host of its own, with
an ordinary conversation as the anchor, runs the core unchanged. Restart
tests use JSONL storage: interrupt a turn, close, reopen, and verify that
the turn completes and its result delivers once. A session stored by
v0.27.0 (`tests/fixtures/v0.27.0`) opens with its agents, graphs, and
undelivered results, resumes its unfinished work on the root anchor, and
continues its request numbering. Graph tests cover `allSettled` with
answers and failures, pipelines, merges with failed inputs, skipped agents,
`failFast` stopping waiting agents, edge validation, stopping a graph, the
ownership tree through the task graph, restarts mid-graph and mid-pipeline
that repeat no finished agent and send no task twice, and messaging a
graph's agent after the graph finished. Tool tests check every result
scripts get against its output schema, for answers, interrupted and failed
turns after an earlier answer, waits ended by a timeout, an abort, or a
steer, and answered, failed, skipped, and stopped graphs. A faux model
holds prompts until the test releases them or the request aborts, so
these tests don't race the model.
Delegation tests cover a fan-out with a merging helper, that helpers and
other agents can't delegate, progress, Esc on the agent, stopping a graph
above it, stopping only the helpers, tool and size limits, names, and a
restart mid-delegation that starts no second set of helpers.
Request limit tests count requests reaching the faux provider: with a limit
of 1, streams, compactions, and spawned agents never overlap, waiting
requests run in order, and one aborted while waiting frees its place.

## Deferred

Composition beyond graphs (result schemas, loops, conditions, races), edges
to agents outside a graph, asynchronous delegation, budgets, MCP, extension
tools, forking agents, a daemon or CLI, agents shared across sessions, and
model changes for running agents.
