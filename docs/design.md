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
- Durable records are the source of truth, so recovery and live operation
  agree on what happened.

## Scope

pi-agents brings durability to Pi. Its core is durable agent execution and
durable messaging: between agents, and from agents back to the parent.
Graphs, delegation, and waits compose these primitives, and the views let
users watch them. Everything else is a customization point, not a feature.

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
[graphs](./graphs.md) for composition and delegation.

## Extension hooks

Agents run outside Pi's extension runner, so Pi's provider events don't
reach them. [Agent hooks](./hooks.md) let extensions capture settings, hold
model calls, and transform requests without making those extensions runtime
dependencies.

Creation captures a snapshot rather than a live link to the parent. This
keeps an agent's settings consistent across retries and recovery; changing
the parent affects future agents only. Helpers inherit their creator's
snapshot. Request transformations use the actual dispatched model, so a
child's provider needn't match the parent's.

The core stores opaque, namespaced state and awaits callbacks. Decisions
about budgets, pricing, or approvals stay with the extension that owns
them.

## Composition

Graphs express dependencies, not a workflow language. Edges carry final
messages without references, schemas, loops, or conditions. For repeated
rounds, Pi can message the same agents again.

Delegation handles work whose shape emerges during a job, such as one
helper per discovered file. The delegating agent waits for its helpers and
continues with their results. Helpers can't delegate or message other
agents, keeping both the depth and coordination scope bounded.

Cancellation follows the work: stopping a graph stops its agents;
interrupting a delegating agent stops its helpers. Stopping only the
helpers lets their agent continue with what finished.

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
rather than interrupting the parent for every intermediate result.

Interrupting an agent means correcting its work, not withdrawing the job.
The parent's request stays open for a later answer. Stopping the agent
withdraws that request. A graph node differs: interruption ends its part
in the graph.

Pi's session and agent storage are separate, so result delivery is
**at least once**: a crash can repeat a result, but doesn't lose it.
This does not guarantee exactly-once tool effects. See
[durability](./architecture.md#durability) for recovery behavior.

## Working-agent cap

The optional cap limits active agents rather than individual requests.
Keeping an agent's requests together benefits model servers with a single
conversation cache. An agent waiting for helpers yields its slot so the
cap cannot prevent those helpers from running.

## Views

The panel shows live state; the transcript and message list show history;
the attach view shows one agent's conversation. Historical tool results
describe what a call observed, not the agent's current state.

## Deferred

Composition beyond graphs (result schemas, loops, conditions, races), edges
to agents outside a graph, asynchronous delegation, MCP, extension tools,
forking agents, a daemon or CLI, agents shared across sessions, and model
changes for running agents.
