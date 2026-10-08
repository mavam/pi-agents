# pi-agents design

pi-agents gives a Pi session durable, named agents that the parent model and
the user can start, message, wait on, watch, and stop. Agents run in-process as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations. This document describes the 1.0 design; composition of agent
results is out of scope and builds on it later.

## Principles

- The agent is the only core abstraction. An agent's result is its last
  assistant message.
- pi-durable is the substrate. We do not run agents as Pi processes.
- The parent conversation stays primary. Agents appear as compact lines, tool
  calls, and result messages.
- The frontend depends on `AgentService` only, never on pi-durable types.

## Core abstractions

| Abstraction | Meaning | Backed by |
| --- | --- | --- |
| Host | One pi-durable `Harness` per parent Pi session | JSONL storage in `~/.pi/agent/pi-agents/<session-id>/` |
| Agent | A durable, named conversation | An ownerless conversation plus an `AgentRecord` |
| AgentRecord | Name, profile, creation time, closed flag, parent requests | The session document `pi-agents.agents` |
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
| `agent_send` | `name`, `message`, `followUp?`, `wait?` (seconds) |
| `agent_wait` | `names`, `timeout?` |
| `agent_status` | `name?` |
| `agent_stop` | `name` |

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

- Panel above the editor: one line per open agent, working first, idle agents
  always shown. Left arrow from an empty editor or Ctrl+Q focuses it; ↑↓
  select, ⏎ attaches, `s` stops, Esc returns. The glyph carries
  the state; working agents show how long they have worked.
- Attach view: a port of Pi's `ExperimentalChatView`, rendering the agent's
  durable conversation view with Pi's message and tool components. ⏎ prompts
  or steers, Alt+⏎ queues a follow-up, Esc interrupts, ← detaches, Shift+↑↓
  scrolls.
- `/agents`: a table of all agents, closed ones dimmed, with details, attach,
  and stop. `/agent <name>` attaches.
- Result messages render the agent, its state, and the result as Markdown.
- The fancy-footer integration reports working and idle counts.

## Testing

Tests use pi-durable's memory storage and pi-ai's faux provider. Restart tests
use JSONL storage: interrupt a turn, close, reopen, and verify that the turn
completes and its result delivers once.

## Deferred

Composition, budgets, MCP, extension tools, nested agents, forking agents, a
daemon or CLI, agents shared across sessions, and model changes for running
agents.
