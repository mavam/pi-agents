# 🤖 pi-agents

Give [Pi](https://pi.dev) durable, named agents. Delegate a job, keep working
while the agent runs, and get its result back as a message. Watch any agent
live, talk to it, or stop it. Agents survive crashes and restarts.

Agents run inside your Pi process on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which
checkpoints every step. When you resume a session, interrupted agents continue
where they stopped.

<table>
  <tr>
    <td width="50%"><img src="demo/agents.gif" alt="Pi starts an audit graph on three models whose reviewers delegate one helper per file, shows the live tree and the merged findings, browses the results in /agents, and spawns three agents that tell jokes"></td>
    <td width="50%"><img src="demo/messaging.gif" alt="Scout messages fixer about a concurrency bug, fixer patches it and replies, and Pi browses their exchange in /messages and attaches to both agents"></td>
  </tr>
  <tr>
    <td align="center">
      <strong>Delegate work to agents and graphs</strong><br>
      <small>Run parallel reviews, follow progress, and bring the findings together.</small>
    </td>
    <td align="center">
      <strong>Agents message each other</strong><br>
      <small>Coordinate a fix between agents, then browse their conversation.</small>
    </td>
  </tr>
</table>

## 🚀 Installation

```sh
pi install npm:pi-agents
```

## ✨ Usage

```text
Have an agent review src/run for error handling while we keep going.
```

```text
Spawn two agents in parallel: one maps the API surface, one checks the tests.
Merge their findings once both report back.
```

```text
Start a graph: three agents review src/run, src/ui, and src/host, and a
fourth merges their findings into one list of issues.
```

```text
Start an agent that may delegate: it finds every module under src, has one
helper review each, and returns one merged review.
```

Pi starts agents only when you ask for delegation. An agent's result is its
final message. Agents work in the background and their results arrive as
messages in your conversation, so you can keep talking to Pi meanwhile. In a graph, agents pass their results to each
other, and Pi gets one message at the end.

The [usage manual](docs/usage.md) covers the rest: the panel, attaching to
agents, graphs, delegation, messaging, profiles, and configuration.

## 🏗️ Architecture

Agents run inside your Pi process. Pi-agents keeps one pi-durable harness per
Pi session, with its own store, kept apart from Pi's session file:

```text
╭─ Pi process ─────────────────────────────────────────────────────╮
│                                                                  │
│  ╭──────────────────╮                    ╭────────────────────╮  │
│ ╭┤  ◆ Pi session    │                    │  ▤ panel           │  │
│ ┊╰───┬──────────▲───╯                    │  ⇄ attach view     │  │
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
│ ┊│   ╭─ graph ─────────────────────────╮                      │  │
│ ┊│   │ ● map ─┬─▶ ◉ core ─┬─▶ ○ report │                      │  │
│ ┊│   │        └─▶ ◉ ui ───┘            │                      │  │
│ ┊│   │            └─ ◉ ◉ ◉ helpers     │                      │  │
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

[docs/architecture.md](docs/architecture.md) explains how agents, graphs,
and results stay durable across crashes and restarts.

## 📚 Documentation

- [Usage](docs/usage.md): glossary, states, skills, UI, commands, and tools.
- [Graphs](docs/graphs.md): coordinating agents and delegating to helpers.
- [Messaging](docs/messaging.md): using messages and their guarantees.
- [Agent profiles](docs/profiles.md): reusable settings and instructions.
- [Configuration](docs/configuration.md): models, requests, and footer counts.
- [Architecture](docs/architecture.md): durable tasks, recovery, and storage.
