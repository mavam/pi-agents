# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. Graphs compose them: agents that pass results to each other.
Agents that may spawn compose them the same way, recursively.

This document explains the design and why it is so. The
[manual](./usage.md) describes what users see.

## Principles

- The agent is the core abstraction. An agent's result is its last assistant
  message. A graph composes agents without changing them.
- pi-durable is the substrate. Agents are durable conversations, not Pi
  processes, so crashes, restarts, and cancellation come from one model.
- The parent conversation stays primary. Agents appear as compact lines, tool
  calls, and result messages, and their results arrive as messages.
- Durable records are the source of truth, so recovery and live operation
  agree on what happened.

## Scope

pi-agents brings durability to Pi. Its core is durable agent execution and
durable messaging: between agents, and from agents back to whoever started
them. Graphs, spawning by agents, and waits compose these primitives, and
the views let users watch them. Everything else is a customization point,
not a feature.

Asynchronous spawning by agents belongs to this core rather than outside
it. An agent that splits its job needs the same durable guarantees as the
parent: results that arrive once, survive crashes, and settle the work that
needed them. A blocking tool call can't give an agent those guarantees
without holding the agent hostage: an interrupt either kills its agents or
leaves the call stuck. Spawning that returns at once, with results that
arrive as input, reuses the parent's model for one more level of owner and
adds no policy.

- **Policy lives outside.** Pricing windows, budgets, quotas, approvals,
  routing, scheduling, and notifications belong to the extensions and users
  that want them. pi-agents offers hooks, events, profiles, and settings at
  its durable boundaries, and the policy sits behind them.
- **Hooks carry data and wait; they don't decide.** pi-agents keeps no
  state, timers, reasons, commands, or views for another extension's
  policy. A hook's contract is its context and when it runs.
- **The smallest hook wins.** A need that extensions can't meet yet gets
  the narrowest hook at an existing durable boundary, preferably one that
  pi-durable already provides, not a mechanism that solves the need inside
  pi-agents.
- **Built-in policy isn't precedent.** Settings such as the working-agent
  cap don't justify adding more policy beside them.

A request that fits none of this is out of scope, even when it is easy to
build. Saying no keeps the core small enough to stay durable.

## Agents

An agent is a named conversation, not a single job. Keeping the conversation
after it answers lets users follow up without reconstructing its context.
Jobs must be self-contained: agents don't see the parent's conversation.

A graph composes agents without changing them. Its edges carry final
messages, and its end nodes provide the result. Agents outlive their graphs
and can continue working independently.

See the [usage glossary](./usage.md#glossary) for user-facing terms and
[graphs](./graphs.md) for composition and agents that spawn agents.

## Extension hooks

Agents run outside Pi's extension runner, so Pi's provider events don't
reach them. [Agent hooks](./hooks.md) let extensions capture settings, hold
model calls, and transform requests without making those extensions runtime
dependencies.

Creation captures a snapshot rather than a live link to the parent. This
keeps an agent's settings consistent across retries and recovery; changing
the parent affects future agents only. Agents that agents spawn inherit
their spawner's snapshot. Request transformations use the actual dispatched model, so a
child's provider needn't match the parent's.

The core stores opaque, namespaced state and awaits callbacks. Decisions
about budgets, pricing, or approvals stay with the extension that owns
them.

## Composition

One spawn starts one graph of one or more agents and reports once. A
single tool covers single agents, fan-outs, and pipelines, so models don't
choose between overlapping tools, and a graph of one is the same thing as
any other graph. Graphs express dependencies, not a workflow language.
Edges carry final messages without references, schemas, loops, or
conditions. For repeated rounds, Pi can message the same agents again.

Agents that may spawn handle work whose shape emerges during a job, such
as one agent per discovered file. They use the parent's tools, and their
graphs report to them the way the parent's report to Pi. Permission is
explicit and doesn't pass down unless asked for, and nesting stops at a
fixed depth, so the tree stays bounded. Ownership is separate from
reachability: an agent reaches the agent that spawned it, the agents it
spawned with it, and its own agents, but no other subtree. Names are
aliases for IDs, which the tools return and accept: a name that fits
several agents is an error rather than a guess, and a call that stops or
messages an agent binds it by ID on its first run, so a rerun after a
restart can't reach another agent that took the name.

An agent's work settles with its first answer after the results it is
owed. An answer before them, such as "checking with my agents", is an
intermediate one, so whoever waits for the agent never gets it as the
result. The evidence is the agent's own transcript: the input that carried
a result, or the wait that returned it. Both the service and the graph task
read it, so they agree after restarts.

Cancellation follows the work. Interrupting an agent corrects it: its
agents keep working, and their results wait until the agent answered
again, so they don't restart the work the user just stopped. Stopping an
agent stops every agent below it in one durable step, through graphs that
finished too, since finished agents can work again. Its work failing
withdraws the graphs it still waits for. Withdrawn graphs stop, and
nothing a stopped agent would start runs, also after a crash. Stopping one
of its graphs still hands the agent what finished.

## Messages between agents

Messages are one-way inputs, not requests that wait for a reply. This lets
agents coordinate without coupling their lifetimes. An agent that needs an
answer asks the recipient to send one back.

Messages between agents are visible to the user but don't start parent
turns. Parent results and peer messages serve different audiences; see
[messaging](./messaging.md) for delivery guarantees and limitations.

## Delivery

The parent conversation stays primary. Spawning and sending return at once;
results arrive as messages. Only an explicit wait blocks, for example when
the parent must combine results before answering. A graph reports once
rather than interrupting the parent for every intermediate result. Agents
get their graphs' results the same way, as input, unless they wait for
them; a result reaches its agent one way, never both.

Interrupting an agent means correcting its work, not withdrawing the job.
The parent's request, or the agent's job in its graph, stays open for a
later answer. Stopping the agent withdraws it.

Pi's session and agent storage are separate, so result delivery is
**at least once**: a crash can repeat a result, but doesn't lose it.
This does not guarantee exactly-once tool effects. See
[durability](./architecture.md#durability) for recovery behavior.

## Working-agent cap

The optional cap limits active agents rather than individual requests.
Keeping an agent's requests together benefits model servers with a single
conversation cache. An agent that waits for its agents yields its slot so
the cap cannot prevent them from running; an agent that ends its turn
instead holds no slot anyway.

## Views

The panel shows live state; the transcript and message list show history;
the attach view shows one agent's conversation. Historical tool results
describe what a call observed, not the agent's current state.

## Deferred

Composition beyond graphs (result schemas, loops, conditions, races), edges
to agents outside a graph, replies to messages as requests with handles of
their own, waits that end when another agent messages the waiting one,
authority beyond the default reach, MCP, extension tools, forking agents, a
daemon or CLI, agents shared across sessions, and model changes for running
agents.
