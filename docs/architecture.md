# Architecture

Pi-agents runs agents in durable tasks with storage separate from Pi's
session file.

## Overview

Agents run inside your Pi process. Pi-agents is a thin bridge from Pi to
pi-durable: it keeps one pi-durable harness per Pi session, with its own store,
kept apart from Pi's session file:

```text
╭─ Pi process ─────────────────────────────────────────────────────╮
│                                                                  │
│  ╭──────────────────╮ ╭────────────────────╮ ╭────────────────╮  │
│ ╭┤ ◆ Pi session:    │ │ ◇ optional         │ │ ▤ panel        │  │
│ ┊│   MCP, extension │ │   extensions, e.g. │ │ ⇄ attach view  │  │
│ ┊│   tools          │ │   pi-service-tier  │ │ ≡ /agents      │  │
│ ┊│                  │ │                    │ │ ✉ /messages    │  │
│ ┊╰───┬─────────▲────╯ ╰─────────┬──────────╯ ╰────────▲───────╯  │
│ ┊    │ agent_* │ results        ╎ hooks:              │          │
│ ┊    │         │                ╎ capture at spawn,   │          │
│ ┊    ▼         │                ▼ adapt requests      │          │
│ ┊╭─────────────┴──────────────────────────────────────┴───────╮  │
│ ┊│  ✦ pi-agents: a thin bridge from Pi to pi-durable          │  │
│ ┊╰───┬─────────▲──────────────────────────────────────────────╯  │
│ ┊    │ start   │ state                                           │
│ ┊    │ message │ results                                         │
│ ┊    ▼ stop    │                                                 │
│ ┊╭─────────────┴──────────────────────────────────────────────╮  │
│ ┊│  pi-durable harness                                        │  │
│ ┊│                                                            │  │
│ ┊│   ◉ scout ─── message ──▶ ● notes                          │  │
│ ┊│                                                            │  │
│ ┊│   ╭─ graph ─────────────────────────╮  agent tools:        │  │
│ ┊│   │ ● map ─┬─▶ ◉ core ─┬─▶ ○ report │  read  bash  edit    │  │
│ ┊│   │        └─▶ ◉ ui ───┘            │  write  grep         │  │
│ ┊│   │            └─ ◉ ◉ ◉ helpers     │  find  ls  codemode  │  │
│ ┊│   ╰─────────────────────────────────╯                      │  │
│ ┊│                                                            │  │
│ ┊│   agents are conversations; turns, tool calls, and graphs  │  │
│ ┊│   are durable tasks that own what they start; model        │  │
│ ┊│   requests pass the hooks with each agent's snapshot       │  │
│ ┊╰─────────────────────────────┬──────────────────────────────╯  │
╰─┬──────────────────────────────┬─────────────────────────────────╯
  ┊ saves                        │ checkpoint every step
  ▼                              ▼
╭──────────────────────╮    ╭──────────────────────────────╮
│ ▤ Pi's session file  │    │ ▤ pi-agents store, one per   │
│   your conversation, │    │   session: agents and their  │
│   saved results, and │    │   hook snapshots, graphs,    │
│   message cards      │    │   messages, tasks            │
╰──────────────────────╯    ╰──────────────────────────────╯
```

Each agent is a conversation in the harness. The work on agents runs as
durable tasks: each turn of an agent, each tool call, and each graph with one
task per agent in it. A task owns what it starts, so stopping a graph reaches
all of its agents, and an agent that delegates starts its helpers as a graph
owned by the tool call that waits for them. A message from one agent to
another is an input to the recipient's conversation, sent by the sender's
tool call.

Agents run outside Pi's extension runner, so Pi's extension events, such as
`before_provider_request`, don't see their requests. Optional extensions reach
them through [creation and request hooks](#creation-and-request-hooks)
instead: a snapshot captured when an agent is created, stored with the agent,
and applied to each of its model requests.

Every step is a commit to the pi-agents store. When you resume a session,
tasks continue where they stopped: agents that finished don't work again, and
a call that already started something finds it instead of starting it twice.
Results reach your conversation through Pi's session file, a separate store,
so a result counts as delivered once Pi saved it there (see
[Durability](./architecture.md#durability)). Agents use your Pi logins and
models, so they need no separate setup.

## Durability

Agents belong to the Pi session that started them. When you quit Pi or it
crashes, agents pause. When you resume the session, for example with `pi -c`,
interrupted work continues and results that haven't arrived yet post into the
conversation. A result has arrived once Pi saved it in the session, so a crash
never loses one; a result that Pi showed but hadn't saved yet posts again, and
after a crash, so may a result that a codemode script waited for. A graph
continues too: its agents that already finished don't work again, and no
agent gets its job twice. A message from one agent to another reaches its
recipient once, also when Pi crashes while sending it. A tool call that
can't safely repeat reports the interruption to the agent instead.

If writing to agent storage fails, for example because the disk is full,
agents pause and Pi tells you. The storage then reopens, and agents continue
as after a restart. If it fails again within a minute, agents stay paused
until you next use them. Sessions started with `--no-session` keep agents
in memory, so a storage failure loses them, and Pi says so.

Agents of sessions started with `--no-session` live in memory and end with
the session.

## Storage

Agents' storage lives in `~/.pi/agent/pi-agents/sessions/<session-id>/`,
with one directory per Pi session, apart from Pi's session file.
Sessions started with `--no-session` keep agents in memory.

## Extension lifecycle events

Co-loaded extensions can observe child agents through `pi.events`, without
parsing the panel or footer. These events describe children, not the parent
Pi session's `agent_start` and `agent_settled` lifecycle.

### Creation and request hooks

Extensions can also initialize persistent, namespaced state at agent creation
and transform child model requests with `onAgentCreate` and `onAgentRequest`.
These callbacks are separate from the notification events described here.
They carry JSON state and provider payloads only; they don't give agents
tools. See [Agent extension hooks](./hooks.md) for the optional protocol,
inheritance, and error handling.

### State snapshots

`pi-agents:state` publishes this protocol in every Pi mode:

```ts
type AgentsStateSnapshot = {
  protocol: 1;
  sessionId: string;
  instanceId: string;
  sequence: number;
  type: "snapshot" | "stopped";
  agents: readonly {
    id: string;
    name: string;
    state:
      | "working"
      | "waiting"
      | "idle"
      | "failed"
      | "interrupted"
      | "skipped";
    closed: boolean;
  }[];
};
```

Each `snapshot` replaces the previous state completely. Its entries are
sorted by ID and include visible agents: open agents and closed agents that
are working again, including graph nodes and delegated helpers. It does not
include prompts, results, tool arguments, or other private conversation data.
The payload, agent array, and entries are detached, frozen objects.

The initial snapshot follows session restoration, including when no agents
exist. Further snapshots publish when membership, name, state, or closed
status changes; streaming progress alone does not produce events.

`instanceId` identifies one publisher/session lifetime and changes on reload
or replacement. `sequence` increases within that instance, starting at one;
never compare sequence numbers across different instances. Consumers should
validate the protocol and payload, scope state to the current session and
publisher instance, and discard duplicate or stale sequences within it.

On graceful shutdown, reload, or session replacement, `stopped` clears live
ownership with an empty array. It does **not** mean stored jobs completed:
durable work may resume in a later process. A process crash cannot publish
this reset; consumers must also respect the owning process's lifetime.

### Requesting current state

Register a `pi-agents:state` listener, then emit
`pi-agents:state:request` with `{ protocol: 1 }` to force a current snapshot.
Requests before initialization are satisfied by the initial snapshot.
Malformed requests and unsupported protocol versions are ignored. This
supports both extension load orders and consumers that attach mid-session.
The protocol is notification-only: it does not resume or stop agents.
Don't emit a request from inside a `pi-agents:state` listener: the reply
arrives synchronously and would trigger the listener again.

For a terminal status integration, keep the pane working while the parent
is active **or** any child's state is `working` or `waiting`. A graph
node's `waiting` state means its work is still pending on its inputs, which
can outlast every `working` child, for example while stored work resumes.
It does not mean waiting for the user, so it must not be interpreted as a
blocked user dialog.

Developers can read [the design document](./design.md) for the design and
its reasons.
