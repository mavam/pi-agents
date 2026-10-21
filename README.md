# 🤖 pi-agents

Give [Pi](https://pi.dev) durable, named agents. Delegate a job, keep working
while the agent runs, and get its result back as a message. Watch any agent
live, talk to it, or stop it. Agents survive crashes and restarts.

> [!CAUTION]
> Agents can't use MCP servers
> ([earendil-works/pi#10837](https://github.com/earendil-works/pi/issues/10837))
> or tools from other extensions, such as web search
> ([earendil-works/pi#10386](https://github.com/earendil-works/pi/issues/10386)).
> They work with Pi's built-in tools: `read`, `bash`, `edit`, `write`, `grep`,
> `find`, `ls`, and `codemode`.

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

Pi starts agents only when you ask for delegation. They work in the
background and return their final messages to your conversation. In a
graph, agents pass results to each other and Pi gets one message at the end.

## 🏗️ Architecture

Agents run inside your Pi process on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
using your Pi logins and models. Resuming a session continues interrupted
work.

```text
Pi process
├─ Your conversation ── delegate ──▶ Agents and graphs
│                    ◀── results ──  ├─ scout ── message ──▶ fixer
│                                    └─ {api, tests} ──▶ merge
├─ Panel, /agents, /messages, attach view
└─ Optional extensions ── hooks ──▶ Agent settings and requests

Pi session file                    Agent storage (pi-durable)
Your conversation and results      Agent conversations and pending work
```

## 📚 Documentation

- [Usage](docs/usage.md): glossary, states, skills, UI, commands, and tools.
- [Graphs](docs/graphs.md): coordinating agents and delegating to helpers.
- [Messaging](docs/messaging.md): using messages and their guarantees.
- [Agent profiles](docs/profiles.md): reusable settings and instructions.
- [Configuration](docs/configuration.md): models, requests, and footer counts.
- [Architecture](docs/architecture.md): recovery, storage, and lifecycle events.
- [Extension hooks](docs/hooks.md): capture settings, hold calls, and adapt requests.
