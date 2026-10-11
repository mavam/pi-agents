# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. Graphs compose them: agents that pass results to each other.

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
- Follow Pi's experimental durable code (`packages/coding-agent/src/experimental/`
  in Pi's repository) where pi-agents does the same thing: its harness
  setup, its session worker's split of host and services, and its
  `subagent` tool.

## Core abstractions

| Abstraction | Meaning | Backed by |
| --- | --- | --- |
| Host | Owns the storage, its lock, and one pi-durable `Harness` per parent Pi session | JSONL storage in `~/.pi/agent/pi-agents/sessions/<session-id>/` |
| Anchor | The conversation that owns the graphs the parent starts | Chosen by the host; inside Pi the harness's root conversation, which never runs |
| Parent | The conversation that starts agents and receives their results | `Parent`, implemented by the host; inside Pi, Pi's session |
| Agent | A durable, named conversation | An ownerless conversation, or one a task owns, plus an `AgentRecord` |
| AgentRecord | Name, profile, creation time, closed flag, parent requests, graph | The session document `pi-agents.agents` |
| Graph | Named agents plus edges that carry results; reports back as one result | A graph task plus a `GraphRecord` |
| GraphRecord | Name, policy, creation time, nodes, closed flag, whether the parent still expects the result | The session document `pi-agents.graphs` |
| Node | One graph agent's task: wait for its inputs, then one message and its answer | A node task |
| Edge | `A → B`: B starts once A finished and receives A's final message | A node's `after` list |
| Result | The last assistant message: text, stop reason, entry ID | The turn's assistant entry |
| Parent request | A turn the parent model started through `spawn` or `send` | An outbox entry in the record plus a submission with request ID `parent:<n>` |
| Profile | Reusable spawn defaults | `<cwd>/.pi/agents/*.md` and `~/.pi/agent/agents/*.md` |
| AgentService | The core: the API for tools and UI | Runs on the harness and anchor the host hands it |

## Structure

pi-agents mirrors the split of Pi's durable session worker, which opens the
store and the harness, hands harness, conversation, models, and settings to
its services, and then resumes the harness:

- **Host** (`src/host`, and `SessionHost` in `src/pi/session.ts`): takes the
  session's lock, opens its storage and the harness with pi-agents'
  extensions installed (`openAgentHarness`, with `createHarnessSettings` and
  `ExecutionEnvs` as in Pi's `harness-setup.ts`), and chooses the anchor.
  It starts the core, then resumes the harness, so recovered work runs
  under the core's eyes. It closes the harness after the core.
- **Core** (`src/agents`): `AgentService` and pi-agents' pi-durable
  extensions. `createAgentExtensions` returns the tools, the prompt, the
  graph tasks, and delegation; `installAgentExtensions` installs them in any
  registry, the way the session worker installs `CodingTools` and its
  prompt. The core never opens storage or a harness, never closes or
  resumes one, and never assumes the root conversation.
- **Frontend** (`src/pi`, `src/ui`): tools, commands, and views. They see
  plain data through `AgentService`, like the session worker's presentations
  see `AgentController` and `Transcript`; only the attach view reads a
  conversation's view.

A durable Pi would host pi-agents in its session worker: install the
extensions in the worker's registry and pass its harness and the session's
main conversation as the anchor.

### The parent

Everything the core needs from the parent goes through `Parent`
(`src/agents/parent.ts`), which the host implements:

- `canDeliver()`: whether the parent takes results now.
- `deliver(deliveries)`: hand results over, in order.
- `received(handovers)`: which deliveries the parent holds durably (see
  "At least once").
- `attention()`: a signal that ends the parent's waits once something needs
  the parent, so it can answer while its agents keep working.
- `subscribe(listener)`: changes that may let delivery proceed.

The core decides what is due and hands it over after every change of its
own and whenever the parent changes. Inside Pi, `PiParent`
(`src/pi/parent.ts`) posts each delivery as a message, the last one starting
a turn, and takes results while Pi is idle, holds no queued messages, and
the user isn't attached to an agent. Every state that keeps Pi from taking
results ends with an event pi-agents follows, or, for the few that end
without one, with a recheck every second while a result waits. A steer from
the user raises the attention signal, because Pi places a steer only after
the current tool round.

## Agents

Agent states are derived, never stored:

- `working`: the conversation has a run.
- `interrupted`: the last answer was aborted.
- `failed`: the last answer ended with an error.
- `idle`: otherwise.

A graph's agent is also `waiting` while an input's node is live, and
`skipped` when none of its inputs answered.

`closed` is a flag that hides an idle agent from the panel; storage keeps it.
Users and models call this *stopping* an agent. An agent closes on its own
once an answer to a parent request is delivered or consumed by a wait and no
parent request remains. Failed and interrupted agents stay open. A parent
message to a closed agent opens it again. A closed agent that works again,
for example because the user talks to it, shows in the panel until it is
idle. Names are unique among visible agents and graphs; a name resolves to
the visible one first, then to the newest closed one. Every creation claims
its names inside its creating commit, so agents started at once can't share
a name.

### Lifecycle

- `spawn` creates the conversation and its record in one commit, then sends
  the task. Settings resolve as profile, then spawn arguments, then the parent
  session's model and thinking level.
- `send` prompts an idle agent and steers a working one; `followUp` queues
  after the current answer instead.
- `wait` resolves once the named agents are idle and returns their results.
  Cancelling a wait cancels only the wait.
- `interrupt` aborts the current work; the agent stays open. Only the attach
  view's Esc interrupts.
- `stop` interrupts, drops pending parent requests, and closes the agent or
  graph it names. The UI asks for confirmation while it works.
- Agents start other agents only when they may delegate; helpers never do.

Parent tools act every time they run. Pi never runs a tool call twice, so
they need no keys. A durable host that replays calls would key what a call
creates by the call's task, as Pi's `subagent` tool and `delegate_graph` do.

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

### Tasks and ownership

The extension `pi-agents-graphs` registers the tasks `pi-agents.graph` and
`pi-agents.node` (see `src/agents/graphs.ts`). Agents never select it.

```text
anchor (inside Pi the harness root; never runs)
└─ graph task             background, owned by the conversation
   └─ node task × n       owned by the graph
      └─ agent conversation   owned by its node
         └─ pi.generation, pi.tool
```

`AgentService.spawnGraph` validates names, tools, thinking levels, and edges,
then creates the graph, its nodes, the agent conversations, and their
records in one commit. A graph starts whole or not at all.

- The graph task is a background task, so nothing on the anchor reaches it,
  and it never blocks idle waits of standalone agents.
- A node waits until all its inputs finished, even when one failed. A node
  whose inputs all failed to answer is skipped.
- `failFast` stops every other live node, including nodes still waiting for
  inputs. Such nodes end as stopped, not skipped.
- Stopping a graph aborts its task, which aborts the nodes and their
  agents bottom-up. A stopped graph delivers nothing.
- Interrupting or stopping one agent ends its node as interrupted rather than
  failed, so `failFast` keeps the other agents working, and nodes after it
  still run with the others' results.
- A node finishes only once its agent's work drained, and the graph only once
  its nodes did, so a follow-up queued to a graph agent holds back the graph
  until the agent answered it. The service counts a graph as working until
  its task is terminal.
- Agents outlive their graph. Once a node is terminal, new work in its
  agent's conversation is ordinary work.

Graphs and standalone agents share one name space.

### Restart

Closing the harness preserves every task. On reopen, finished nodes never run
again, and a running node reruns its phase: it builds the same message from
stored answers, and its request ID (`node:<task-id>`) finds the submission it
already made, so the agent gets its task once while pi-durable resumes its
run. These guarantees cover admission: a model call or tool effect that was
in flight at the crash can run again.

### Versions and migration

Tasks and documents are at version 1. A later change to a task's input or
checkpoint bumps its `version` and adds `migrate`; a migration must keep the
task IDs in checkpoints. Terminal tasks never migrate. A task whose
definition is missing stays blocked rather than lost; stopping its graph then
settles it as `orphaned`. Documents migrate through `defineDoc`'s `migrate`.
Optional fields that earlier records lack need no migration. Stores of
earlier builds may hold the documents `pi-agents.stops` and
`pi-agents.receipts`; nothing reads them.

### Agents that delegate

An agent with `delegate` splits its own task at runtime: it starts a graph of
helpers, waits for it, and continues with its result in the same run. This
covers map, fan-out over what the agent discovers, and nested workflows,
without a language.

The extension `pi-agents-delegation` holds one tool, `delegate_graph`, with
the shape of `agent_spawn_graph` minus `wait`. The call blocks and returns
the graph's result as the tool result, within a budget below pi-durable's
tool output limit. It follows Pi's foreground `subagent` tool: what it
starts belongs to the call's task, and `replay: "safe"` lets a rerun find it.

```text
delegating agent's conversation
└─ pi.generation → pi.tool (delegate_graph)
   └─ graph task          owned by the tool task; not background
      └─ node task × n
         └─ helper conversation
```

- Esc on the agent aborts the tool and, bottom-up, the helpers; stopping a
  graph the agent belongs to reaches them too. Stopping only the helpers
  ends the call with a "stopped" result, and the agent goes on.
- A restart reruns the call, which finds the graph its tool task owns and
  waits for it. Finished helpers don't rerun, and no helper gets its task
  twice.
- Only delegating agents select the extension; the tool also refuses agents
  whose record doesn't allow it and helpers. pi-durable copies an owner
  task's agent settings into the conversations it owns, so every helper is
  configured explicitly, without delegation. Depth is therefore 2.
- Helpers get only tools their agent has. Profiles, models, and skills
  resolve like Pi's spawns, with the agent's model, thinking level, and
  working directory as defaults.
- Helpers are named `<agent>.<name>` and their graph `<agent>.<name or
  helpers>`. The panel drops the agent's part below the agent.
- Limits, fixed: 12 helpers per call, 24 per agent, and 16 working at once
  across the session. A call over a limit returns an error the agent can act
  on.
- The tool result is the graph's delivery; Pi's outbox isn't involved. Once
  the call ended, the service closes the graph and its helpers.

## Delivery

Parent requests use an outbox: the record stores the request ID and message
first, then the submission follows with the same request ID. When the service
starts, it resubmits outbox entries without a submission; the request ID
makes this idempotent.

When a parent request settles:

1. If a `wait` covers the agent, the wait consumes the result.
2. Otherwise the result is posted into the parent as a `pi-agents:result`
   message once the parent takes results.
3. Aborted requests deliver nothing.
4. Several requests answered by the same entry deliver once.

A graph delivers one `pi-agents:graph-result` message with the outcomes of
its end nodes, and names the agents in between that didn't answer. A node's
answer is the one to its graph task, even if the agent answered later
messages since. While the graph's result is pending, its agents deliver
nothing of their own; the graph's delivery covers their answers to it. The
graph closes on delivery, and so do its agents that answered, were skipped,
or that the graph stopped; failed and interrupted agents stay open.

Turns the user starts from the attach view never deliver into the parent.

### At least once

Pi's session is a store of its own, so no commit spans the harness and the
session. Delivery to the parent is therefore at least once: a crash never
loses a delivery but can repeat one.

- Every delivery has a stable identity derived from stored records, such as
  `agent:<id>@<created>:entry:<entry>`. The creation time keeps identities
  unique across stores, since a forked Pi session copies its messages while
  its agents start over.
- A delivery counts as done only once `Parent.received` reports that the
  parent holds it. Pi's parent looks for the identity in the session's
  entries, on any branch: in a result message (`details.delivery`), or in
  the stored result of a call that waited (`details.deliveries`).
- Handed over but not yet held, a delivery is in flight, in memory only, and
  isn't handed over again. After a restart, deliveries the session holds are
  acknowledged without posting, and the others are posted again.
- Pi stores no results of nested calls, such as a codemode script's. So the
  core remembers in memory which call took which results, and Pi's parent
  counts them once Pi stored the caller's result, which records the nested
  call. A crash forgets this, so a result a script waited for may post
  again.
- Pi confirms neither posting nor saving, and extensions see `message_end`
  before Pi saves the message, so the parent checks the session's entries
  again after events. Messages are posted only while Pi is idle, in the same
  synchronous step that checks it, so Pi saves them at once or in the turn
  they start. A message posted while Pi settles its last run waits in Pi's
  deferred actions; if the session ends first, it shows `result queued`
  until the session starts again.

## Durability

- Quitting or crashing Pi pauses agents. Resuming the session with `pi -c`
  reopens the host, resumes interrupted work, and delivers pending results
  that the session doesn't hold yet.
- Switching sessions pauses that session's agents until the user returns.
- A lock file gives one Pi process ownership of a session's agents. Another
  process shows a notice and runs without agents.
- A session without a file (`--no-session`) keeps its agents in memory.

## Agent runtime

- Extensions: every agent names the extensions it selects: pi-agents' tools
  and prompt, plus delegation for delegating agents, so the harness's
  default selection, which in Pi's session worker would be Pi's own tools
  and prompt, never reaches agents. Agents stored by earlier versions name
  none and follow the default, which Pi's host sets to pi-agents' tools and
  prompt.
- Tools: `read`, `write`, `edit`, and `bash` from pi-durable, plus `grep`,
  `find`, and `ls` adapted from Pi's tool definitions. The default set is
  Pi's: `read`, `bash`, `edit`, `write`.
- System prompt: a delegation preamble, tool guidelines, context files such as
  `AGENTS.md`, skills, the working directory and date, and profile
  instructions.
- Profiles: `.pi/agents` of the agent's working directory, the `.pi` Pi
  reads project skills and settings from. Untrusted projects contribute none.
- Skills: agents find what Pi finds on disk for the agent's directory and the
  project's trust (`src/catalog/skills.ts`), loaded once per directory and
  trust like Pi at startup; `/reload` starts afresh. Session-only resources
  (`--skill`, `-e` packages, skills extensions add, `--no-skills`) don't
  reach agents. An agent sees the catalog unless a profile or the spawn names
  skills: a named list inlines those skills and turns the catalog off, and an
  empty list means none. Models can't name skills marked
  `disable-model-invocation`; only the user can, in a profile. An unknown
  skill fails the spawn, and a graph or helper set resolves all of its
  agents before any starts.
- Models: the parent session's model runtime, so logins and custom providers
  work.
- Settings: compaction, retry, queue modes, and stream timeouts come from
  Pi's settings.
- Request limit: `piAgents.maxConcurrentRequests` caps the model requests
  the session's agents make at once. The host wraps the `Models` it gives
  the harness, so generation and compaction requests of agents, graph nodes,
  and helpers all count; the parent's own requests don't. Requests over the
  cap wait in order; an abort while waiting ends the request as aborted. It
  never refuses work. Read when the host opens; an invalid value shows a
  warning and means no limit.
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

`agent_spawn_graph` is a separate tool because "either `task` or `agents`"
cannot be expressed in the tool schemas that providers accept. Agents without
a name are called `<graph>-<n>`, or after their profile. `agent_send` to a
graph fails and lists its agents. Models sometimes pass `wait: false` or
quoted numbers, so the tools drop seconds that aren't positive numbers and
parse numeric strings.

Each tool declares an output schema and returns structured content, which
codemode scripts receive instead of the text (`src/pi/output.ts`):

| Tool | Output |
| --- | --- |
| `agent_spawn`, `agent_send` | the agent |
| `agent_spawn_graph` | the graph |
| `agent_wait` | `agents`, `graphs`, and `pending`: the names the wait ended before |
| `agent_status` | `agents` and `graphs` |
| `agent_stop` | `kind`, `name`, and `state` of what stopped |

An agent is its `name`, `state`, `graph`, and what its latest turn produced:
`result` when it answered or wrote something before it was interrupted,
`error` when it failed, and nothing while it works or waits. A turn never
reports an earlier turn's answer. A graph is its `state`, `stopped`, and per
agent its `after`, `end`, and `outcome`, with `result` or `error`; nodes
carry the answer to the graph's task. Results keep the limit of the text the
model reads and say when they were cut with `truncated`. Calls that wait
return what they observed after the wait.

A steer from the user ends every running wait at once; the agents keep
working and their results arrive as messages. Follow-ups don't end waits.

The system prompt adds one line of guidance, the usable profiles, and the
user's scoped models, so the parent recognizes model names. The `model`
argument and profile models resolve like `pi --model` patterns among models
with credentials. Profiles with an unavailable model or unresolvable skills
stay out of the prompt, and the UI reports them once per session.

### Tool rendering

A result stays in the transcript, so it shows only what stays true; the
panel is the only surface with live state. Each call stores a *receipt* in
its result's details (`src/agents/receipts.ts`), plain data from one
observation:

- what the call started: agents and graphs with inputs and models;
- how agents and graphs were when the call looked: answered, failed,
  interrupted, stopped, skipped, or still working or waiting, with usage
  and answers once finished;
- how its wait ended: done, timed out, cut short for the parent, or
  cancelled.

No clocks, activity, or delivery markers. The deliveries a wait took stay
beside the receipt, in the same details, for delivery bookkeeping.

`src/ui/tool-views.ts` draws calls and results and never sees live agents.
A call draws its arguments only: its title, a dim `key=value` line, and its
body. A result draws its receipt only: progress what the call started, the
final result how agents were, with `⊠` for what a wait gave up on, then why
it ended, such as `Timed out`. Renderers share no state, so a call draws the
same live, finished, and replayed. A failed call shows its error text.
Results stored by earlier versions decode to receipts when read, and
details no version reads show the result's text.

Pi's transcript and the attach view each have a map from tool name to
renderers, since the parent's tools and the agents' tools differ: the
parent's tools use them through their definitions, and the attach view
draws `delegate_graph` with its own, and Pi's tools with Pi's.

## Frontend

- Panel above the editor: one line per open agent or graph, working first. A
  graph's line shows how many of its agents finished, with its agents below
  it as a tree in stages; unfocused, a finished graph folds to its line. ←
  from an empty editor or Ctrl+Q focuses it, or opens `/agents` while it's
  empty. Space folds a graph or an agent's helpers, ⏎ attaches, `s` stops,
  Tab trades the panel for `/agents` at the same row. The panel and
  `/agents` share what the user folded. Before intercepting input or taking
  focus, the controller checks `TUI.hasOverlay()` and yields to any visible
  overlay. This is intentionally conservative: `hasOverlay()` includes
  visible `nonCapturing` overlays and overlays that released focus to another
  target. Hidden overlays, including those whose `visible` callback returns
  false, do not block navigation. Pi's public API does not expose whether an
  overlay currently owns keyboard focus. The panel's widget stays mounted
  with empty output while hidden or empty so the check always uses the current
  TUI. No extension-specific lifecycle events are needed.
  Working agents show how long ago they started; finished rows show no time. An
  idle agent or finished graph with an undelivered result shows `●` in the
  accent color and `result queued`.
- Attach view: a port of Pi's `ExperimentalChatView`, rendering the agent's
  durable conversation view with Pi's message and tool components. ⏎ prompts
  or steers, Alt+⏎ queues a follow-up, Esc interrupts, Ctrl+O expands tool
  output, ← detaches.
- `/agents`: a table of all agents and graphs, closed ones dimmed, with
  details, attach, and stop. Each row shows how long it ran: until now while
  it works, else until it ended, from durable task end times that survive
  restarts. An agent's detail shows its task and its latest result; a
  graph's detail says its order in words and shows each agent's result.
- pi-durable's task graph stays out of the UI. `AgentService.liveTasks()`
  exposes it for tests and debugging.
- The fancy-footer integration reports working and idle counts.

## Testing

Tests use pi-durable's memory storage, or JSONL storage for restarts, and
pi-ai's faux provider, and open the harness through the same host function
as Pi. Delivery tests run Pi's parent over Pi's own `SessionManager`. See
`AGENTS.md` for what to test.

## Deferred

Composition beyond graphs (result schemas, loops, conditions, races), edges
to agents outside a graph, asynchronous delegation, budgets, MCP, extension
tools, forking agents, a daemon or CLI, agents shared across sessions, and
model changes for running agents.
