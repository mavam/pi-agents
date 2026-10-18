# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. Graphs compose them: agents that pass results to each other.

This document explains the design and why it is so. The
[manual](./usage.md) describes what users see.

## Principles

- The agent is the core abstraction. An agent's result is its last assistant
  message. A graph composes agents without changing them.
- pi-durable is the substrate. Agents are durable conversations, not Pi
  processes, so crashes, restarts, and cancellation come from one model.
- The parent conversation stays primary. Agents appear as compact lines, tool
  calls, and result messages, and their results arrive as messages.
- Every state is derived from durable records, never kept beside them.
- The frontend sees plain data from the core, never pi-durable's types.
- The host owns the harness, so the same core could later run inside a
  durable Pi session with a different host.

## Concepts

pi-agents calls the instructions an agent starts with its *job*. *Task*
means only pi-durable's durable units of work: a turn, a tool call, a graph,
a node.

| Concept | Meaning |
| --- | --- |
| Host | Owns the storage, its lock, and one pi-durable harness per Pi session |
| Parent | The conversation that starts agents and receives their results; inside Pi, Pi's session |
| Anchor | The conversation that owns the graphs the parent starts |
| Agent | A durable, named conversation with a record of its name, profile, job, and parent requests |
| Job | The self-contained instructions an agent starts with; it doesn't see the parent's conversation |
| Result | An agent's last assistant message |
| Graph | Named agents plus edges that carry results; reports back as one result |
| Edge | `A → B`: B starts once A finished and receives A's final message |
| Parent request | A turn the parent started by spawning or messaging an agent |
| Profile | Reusable spawn defaults with instructions |

## Layers

pi-agents has three layers:

- **Host:** takes the session's lock, opens its storage and the harness
  with pi-agents' extensions installed, and chooses the anchor. It starts
  the core before it resumes the harness, so recovered work runs under the
  core's eyes, and closes the harness after the core.
- **Core:** the agent service and pi-agents' pi-durable extensions: the
  agents' tools and prompt, graph tasks, delegation, and messaging. The
  core never opens, resumes, or closes a harness and never assumes which
  conversation anchors it. It is split by concern (storage access,
  observation, projection, delivery, waits, creation), and lower parts never
  depend on higher ones.
- **Frontend:** Pi's tools, commands, and views. They see plain data
  through the service; only the attach view reads a conversation directly.
  The frontend also publishes the agents' lifecycle state on Pi's event
  bus, so other extensions can follow children without parsing views.
  Snapshots carry only names and states, never conversations, and each
  replaces the last, so a listener that joins late needs only one. They
  start once the session is restored and end with an explicit reset at
  shutdown, which says nothing about whether stored work finished. See the
  [extension event protocol](./architecture.md#extension-lifecycle-events).

Everything the core needs from the parent goes through one interface:
whether the parent takes results now, handing results over, which results
the parent holds durably, a signal that ends the parent's waits when
something needs it, and change notifications. Inside Pi, the parent posts
results as messages, the last one starting a turn, and takes them only
while Pi is idle, holds no queued messages, and the user isn't attached to
an agent. A steer from the user ends the parent's waits, because Pi places
a steer only after the current tool round.

## Agents

Agent states are derived from the conversation, never stored: `working`
while it has a run, `interrupted` or `failed` after an aborted or failed
answer, `idle` otherwise. A graph's agent is also `waiting` for its inputs
or `skipped` when none of them answered.

Stopping an agent closes it: a flag that hides it, while storage keeps it.
An agent also closes on its own once its answer is delivered or consumed by
a wait and no parent request remains; failed and interrupted agents stay
open. Messaging a closed agent opens it again. Closed is a status of its
own, shown with one glyph wherever an agent's status appears: the panel
hides closed agents, while `/agents` and the footer count keep them,
because Pi can still reach them. Closed helpers drop out of the footer,
since nobody can message them. Graph details and tool results show how an
agent's work ended instead, so they keep the outcome's glyph. Names are unique among
visible agents and graphs, claimed in the commit that creates them, so
agents started at once can't share one.

Settings resolve as spawn arguments, then the profile, then the parent
session. Only waits block; every other operation returns at once, and
results arrive as messages. Agents start other agents only when they may
delegate.

## Graphs

A graph runs on pi-durable's tasks and ownership tree, so its bookkeeping is
durable and cancellable without hand-written state machines:

```text
anchor
└─ graph task             background, owned by the anchor
   └─ node task × n       owned by the graph
      └─ agent conversation   owned by its node
```

- One commit creates the graph, its nodes, and its agents, so a graph
  starts whole or not at all.
- An edge appends the input's final message to the receiving agent's job.
  There is no language: no references, schemas, loops, or conditions.
- The agents nothing waits for are the graph's end nodes; their results are
  the graph's result.
- A node waits until all its inputs finished, even when one failed, and is
  skipped when none answered. Fail-fast stops every other live node instead.
- Stopping a graph aborts its task, which aborts its nodes and agents
  bottom-up. Stopping or interrupting one agent ends its node as
  interrupted, so the others continue.
- A node finishes only once its agent's work drained, so a follow-up to a
  graph agent holds back the graph until the agent answered it.
- Agents outlive their graph; later work in their conversations is ordinary
  work.

After a restart, finished nodes never run again. A running node rebuilds its
message from stored answers, and a request ID derived from its task finds
the submission it already made, so no agent gets its job twice. This covers
admission: a model call or tool effect in flight at the crash can run again.

Task inputs and pi-agents' documents carry versions and migrate. A task
whose definition is missing stays blocked rather than lost.

## Delegation

A delegating agent splits its own job at runtime: it starts a graph of
helpers, waits for it, and continues with its result in the same run. This
covers fan-out over what the agent discovers without a workflow language.

The delegation tool blocks and returns the graph's result as its tool
result. The graph belongs to the tool call's task, not the anchor:

```text
delegating agent's conversation
└─ tool call (delegate_graph)
   └─ graph task          owned by the tool call
      └─ node task × n
         └─ helper conversation
```

- Interrupting the agent aborts the call and, bottom-up, its helpers.
  Stopping only the helpers ends the call with a "stopped" result, and the
  agent goes on.
- The tool is replay-safe: a rerun after a restart finds the graph its call
  owns and waits for it, so finished helpers don't run again.
- Helpers never delegate or message, so depth is 2. pi-durable copies an
  owner's agent settings into the conversations it owns, so every helper is
  configured explicitly.
- Helpers get only tools their agent has, and resolve profiles, models, and
  skills like spawns, with their agent's settings as defaults.
- Fixed limits on helpers per call, per agent, and across the session
  return errors the agent can act on.
- The tool result is the graph's delivery. Once the call ended, its graph
  and helpers close.

## Messages between agents

Every agent that isn't a helper can message the others and list them;
[messaging](./messaging.md) states the guarantees. The design behind them:

- A send binds its recipient once, by conversation, in a memo of its tool
  call, so a rerun never resolves the name again.
- Sends to one recipient take turns. Each logs the message and checks that
  the recipient isn't stopped in one commit, then submits it with a request
  ID derived from the tool call, so the recipient admits it once.
- A stop takes the recipient's turn too: a send before it is withdrawn or
  interrupted, a send after it refused.
- After a crash, the service submits logged messages that lack a
  submission, or marks them dropped when the recipient is gone, before work
  resumes.
- A message's status derives from its submission: queued, delivered once
  placed, or dropped.
- The recipient's answer is not a delivery: deliveries follow parent
  requests only.

## Delivery

A parent request is recorded before it is submitted, under the same request
ID, so a crash between the two resubmits it idempotently.

When a parent request settles, a wait that covers the agent consumes the
result; otherwise the result is posted to the parent once it takes results.
Requests answered by the same entry deliver once. A graph delivers once,
with its end nodes' results, and its agents deliver nothing of their own
meanwhile. Turns the user starts from the attach view don't deliver, except
to settle an interrupted request.

Interrupting a request doesn't settle it. Users interrupt to correct an
agent, not to withdraw its job, so the request stays open and the agent's
first finished answer after an input from the request on settles it,
whoever started that turn. An answer to a turn that began before the
request entered the conversation never stands in for it, and since entries
never change, the settling answer stays the same through later turns and
restarts. Stopping the agent withdraws its open requests and delivers
nothing. A graph agent's job is not a parent request: interrupting it ends
its node as interrupted.

Results reach the parent whole. Failures retain the error text from the
request that failed, rather than looking it up from the agent's latest
turn, which may have changed before delivery. Cards may collapse long
errors, but no budget cuts what the model reads; limits wait until large
results show what a good mechanism looks like.

### At least once

Pi's session is a store of its own, so no commit spans the harness and the
session. Delivery is therefore at least once: a crash never loses a result
but can repeat one.

- Every delivery has a stable identity derived from stored records,
  including the agent's creation time, since a forked Pi session copies its
  messages while its agents start over.
- A delivery counts as done once the parent holds it: Pi's parent finds the
  identity in the session's entries, in a result message or in the stored
  result of a call that waited. Until then it is in flight, in memory only,
  and posted again after a restart.
- Pi stores no results of nested calls, such as a codemode script's. Which
  call took which results lives in memory until Pi stores the caller's
  result, so a crash can repeat a result a script waited for.
- Results are posted in the same synchronous step that checks Pi is idle,
  so Pi saves them at once or in the turn they start.

## Durability

- Quitting or crashing Pi pauses agents. Resuming the session reopens the
  host, resumes interrupted work, and delivers results the session doesn't
  hold yet. Switching sessions pauses that session's agents.
- A lock gives one Pi process ownership of a session's agents.
- Sessions without a file keep their agents in memory.
- A storage error closes the harness. The host pauses the agents, tells the
  user, and reopens the harness, which resumes work like a restart. Repeated
  failures don't loop: within a minute, agents wait for the next use.
  Memory storage can't reopen, so those agents are lost, and the user hears
  so. Closing and reopening are ordered, and a shutdown or session change
  ends a recovery, so it never reopens storage that belongs to a session
  that's gone.

## Agent runtime

- Agents name the extensions they select, so the harness's default
  selection never reaches them.
- Tools: pi-durable's `read`, `write`, `edit`, `bash`, and `codemode`, plus
  Pi's read-only `grep`, `find`, and `ls`. Agents inherit the parent's active
  tools among these, and helpers their agent's, unless a spawn or profile
  names tools; without any, they get Pi's default set.
- `codemode` scripts call the agent's other tools as nested calls, each a
  task of its own owned by the script's call, so a script's delegations get
  their own graphs, and pi-durable replays a script after a restart.
- `codemode` scripts get `models.*` as in Pi. pi-durable runs classifier
  and image calls as internal tools only scripts can call, so each is a
  nested call with its own usage and replay policy. An agent enables them
  exactly when it has `codemode`, and a helper gets them only with
  `codemode` and only when its agent has them, so they never widen what an
  agent can do. Nobody selects them by name, and tool lists don't show
  them. Opening a session gives every stored agent with `codemode` these
  tools before its work resumes, so it holds for agents of any age.
- `read` shows agents images, converted and shrunk to the model's limits.
- MCP servers and tools of other extensions live in Pi's session, which
  pi-durable can't reach yet (earendil-works/pi#10837,
  earendil-works/pi#10386).
- The system prompt follows Pi's: preamble, tools and their guidelines,
  context files, skills, working directory, and date, plus profile
  instructions.
- Profiles and skills come from where Pi finds them for the agent's
  directory; untrusted projects contribute none. Models can't name skills
  only the user may invoke.
- Models, logins, and settings come from the parent session.
- A session-wide cap on working agents queues agents, never refuses them,
  and leaves the parent alone. It holds per agent, not per request: an
  agent keeps its slot from its first request until its work ends, so a
  server that serves one conversation at a time keeps its cache instead of
  switching between agents at every tool call. Its compactions keep the
  slot until they end. An agent waiting for its helpers gives its slot up
  and doesn't take it back until they finish, or a cap of one would
  deadlock. Slots are taken before requests and before compactions
  summarize, so a summary that a restart resumes runs without one.
- Storage of old sessions is deleted after a configurable retention, in the
  background and never for sessions a live process holds.

## Parent tools

- Blocking lives in one place, the wait tool. Results arrive as messages
  without a wait, so the tools and prompt steer the parent to end its turn
  or keep working, wait only when a turn must combine results, and never
  poll. Single-shot modes end with the parent's answer, so there the prompt
  asks the parent to wait for what it needs.
- Spawning a graph is its own tool, because "either a job or agents" can't
  be expressed in the tool schemas providers accept.
- Each tool declares structured output, so codemode scripts get agents,
  graphs, and results as data. A turn never reports an earlier turn's
  answer.
- The prompt lists usable profiles and the user's scoped models; profiles
  that can't resolve stay out and are reported once.

### Rendering

A tool result stays in the transcript, so it shows only what stays true;
the panel is the only surface with live state. Each call stores a receipt,
plain data from one observation: what it started, how agents and graphs
were when it looked, and how its wait ended. Renderers share no state, so a
call draws the same live, finished, and replayed.

Each surface has one job: the panel shows live state, the transcript and
the message list show history, and the attach view shows one agent's
conversation. One module draws messages for all of them.

The focused panel keeps only its own keys. Any other key, including typed,
pasted, or encoded text, returns focus to the editor where it lands, so Enter
after editing submits to the parent rather than opening an agent. Terminal
reports aren't keys and leave focus alone. Panel navigation applies only
while the prompt editor owns input. Selectors and dialogs keep their keys,
whether they appear as overlays or replace the editor, so an empty prompt
doesn't let the panel intercept another view's navigation.

## Deferred

Composition beyond graphs (result schemas, loops, conditions, races), edges
to agents outside a graph, asynchronous delegation, budgets, MCP, extension
tools, forking agents, a daemon or CLI, agents shared across sessions, and
model changes for running agents.
