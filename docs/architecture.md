# Architecture

Pi-agents runs agents in durable tasks with storage separate from Pi's
session file.

## Overview

Agents run inside your Pi process. Pi-agents keeps one pi-durable harness per
Pi session, with its own store, kept apart from Pi's session file:

```text
╭─ Pi process ─────────────────────────────────────────────────────╮
│                                                                  │
│  ╭─────────────────────────────────────╮ ╭────────────────────╮  │
│ ╭┤  ◆ Pi session: MCP, extension tools │ │  ▤ panel           │  │
│ ┊╰───┬──────────▲──────────────────────╯ │  ⇄ attach view     │  │
│ ┊    │ agent_*  │ results                │  ≡ /agents         │  │
│ ┊    ▼          │                        │  ✉ /messages       │  │
│ ┊╭──────────────┴───╮                    ╰─────────▲──────────╯  │
│ ┊│  ✦ pi-agents     ├◀─────────────────────────────╯             │
│ ┊╰───┬──────────▲───╯                                            │
│ ┊    │ start    │ state                                          │
│ ┊    │ message  │ results                                        │
│ ┊    ▼ stop     │                                                │
│ ┊╭──────────────┴─────────────────────────────────────────────╮  │
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
│ ┊│   are durable tasks that own what they start               │  │
│ ┊╰─────────────────────────────┬──────────────────────────────╯  │
╰─┬──────────────────────────────┬─────────────────────────────────╯
  ┊ saves                        │ checkpoint every step
  ▼                              ▼
╭──────────────────────╮    ╭──────────────────────────────╮
│ ▤ Pi's session file  │    │ ▤ pi-agents store, one per   │
│   your conversation, │    │   session: agents, graphs,   │
│   saved results, and │    │   messages, tasks            │
│   message cards      │    │                              │
╰──────────────────────╯    ╰──────────────────────────────╯
```

Each agent is a conversation in the harness. The work on agents runs as
durable tasks: each turn of an agent, each tool call, and each graph with one
task per agent in it. A task owns what it starts, so stopping a graph reaches
all of its agents, and an agent that delegates starts its helpers as a graph
owned by the tool call that waits for them. A message from one agent to
another is an input to the recipient's conversation, sent by the sender's
tool call.

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

Developers can read [the design document](./design.md) for the design and
its reasons.
