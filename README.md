# 🤖 pi-agents

Give [Pi](https://pi.dev) durable, named agents. Delegate a task, keep working
while the agent runs, and get its result back as a message. Watch any agent
live, talk to it, or stop it. Agents survive crashes and restarts.

Agents run inside your Pi process on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which
checkpoints every step. When you resume a session, interrupted agents continue
where they stopped.

## 🚀 Installation

```sh
pi install npm:pi-agents
```

## ✨ Usage

Ask Pi to delegate:

```text
Have an agent review src/run for error handling while we keep going.
```

```text
Spawn two agents in parallel: one maps the API surface, one checks the tests.
Wait for both and merge their findings.
```

Pi starts agents only when you ask for delegation. An agent's result is its
final message. Results of agents that Pi doesn't wait for arrive later as
messages in your conversation.

### Architecture

Agents run inside your Pi process. Pi-agents keeps one pi-durable harness per
Pi session; each agent is a conversation in that harness:

```text
╭─ Pi process ─────────────────────────────────────────────────────╮
│                                                                  │
│  ╭──────────────────╮                    ╭────────────────────╮  │
│  │  ◆ Pi session    │                    │  ▤ panel           │  │
│  ╰───┬──────────▲───╯                    │  ⇄ attach view     │  │
│      │ agent_*  │ results                │  ≡ /agents         │  │
│      ▼          │                        ╰─────────▲──────────╯  │
│  ╭──────────────┴───╮                              │             │
│  │  ✦ pi-agents     ├──────────────────────────────╯             │
│  ╰───┬──────────▲───╯                                            │
│      │ start    │ state                                          │
│      │ message  │ results                                        │
│      ▼ stop     │                                                │
│  ╭──────────────┴─────────────────────────────────────────────╮  │
│  │  pi-durable harness                                        │  │
│  │                                                            │  │
│  │   ╭─────────────╮   ╭─────────────╮   ╭─────────────╮      │  │
│  │   │ ◉ agent     │   │ ◉ agent     │   │ ● agent     │  …   │  │
│  │   ╰─────────────╯   ╰─────────────╯   ╰─────────────╯      │  │
│  │   one conversation per agent                               │  │
│  ╰─────────────────────────────┬──────────────────────────────╯  │
╰────────────────────────────────┼─────────────────────────────────╯
                                 │ checkpoint every step
                                 ▼
                   ╭───────────────────────────╮
                   │  ▤ JSONL, one per session │
                   ╰───────────────────────────╯
```

Because pi-durable checkpoints every step, a resumed session continues where
its agents stopped. Agents use your Pi logins and models, so they need no
separate setup.

### Glossary

| Term | Meaning |
| --- | --- |
| Agent | A separate Pi agent with its own name, model, working directory, and conversation. It keeps its conversation after it answers. |
| Task | The first message an agent gets. It must stand on its own, because the agent doesn't see your conversation. |
| Message | Any later input to an agent. A message to a working agent *steers* it; a *follow-up* waits until the current answer is done. |
| Result | The agent's final message after a task or message. |
| Profile | Reusable settings for agents, such as model, thinking level, tools, and instructions. |
| Attach | Open an agent's conversation to watch it and talk to it. |
| Stop | End an agent and remove it from the panel. Agents end on their own once their answer reaches Pi. Messaging an agent that ended starts it again. |

An agent is in one of these states:

| State | Meaning |
| --- | --- |
| ◉ `working` | The agent works on a task or message. |
| ● `idle` | The agent answered and waits for messages. |
| ✗ `failed` | The last answer ended with an error. |
| ⊘ `interrupted` | The last answer was interrupted before it finished. |

Agents use Pi's tools `read`, `bash`, `edit`, `write`, `grep`, `find`, and
`ls`, along with your context files such as `AGENTS.md` and your skills. They
can't use MCP servers, tools from other extensions, or other agents.

### Watch and talk to agents

A panel above the editor shows one line per open agent. The glyph shows the
state, and working agents show how long they have worked:

```text
◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep
✗ docs · sol · 8.0k · $0.02 · rate limit exceeded
```

An agent leaves the panel once its answer reaches Pi. Failed and interrupted
agents stay until you or Pi stop them.

Press ← in an empty editor or Ctrl+Q to focus the panel. Then:

| Key | Action |
| --- | --- |
| ↑ ↓ | Select an agent. |
| ⏎ | Attach to the agent. |
| `s` | Stop the agent. Pi asks first when it still works. |
| Esc | Return to the editor. |

Attaching shows the agent's conversation with Pi's own message and tool
rendering. The editor then talks to the agent:

| Key | Action |
| --- | --- |
| ⏎ | Prompt an idle agent or steer a working one. |
| Alt+⏎ | Queue a follow-up after the current answer. |
| Esc | Interrupt a working agent. Queued messages return to the editor. |
| ← | Detach when the editor is empty. |
| Shift+↑ ↓, Shift+PgUp/PgDn | Scroll. |

Messages you send while attached stay between you and the agent. Their
results don't post into the parent conversation.

### Commands

| Command | Action |
| --- | --- |
| `/agents` | Browse all agents, including ended ones, with their task and latest result. Attach to or stop them. |
| `/agent <name>` | Attach to an agent. |

### Tools

Pi uses these tools to work with agents:

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start an agent on a task, optionally waiting for its result. |
| `agent_send` | Message an agent: prompt, steer, or queue a follow-up. |
| `agent_wait` | Block until agents answer and return their results. |
| `agent_status` | Show agent states. |
| `agent_stop` | Stop an agent. |

`agent_spawn` and `agent_send` can also block for the result: their `wait`
argument sets the most seconds to wait. A result that a wait returns doesn't
post again as a message. Cancelling a wait leaves the agents working.

Each tool call shows the arguments Pi chose on a dim line below it:

```text
✦ spawn lister
  profile=explorer thinking=low tools=[read,ls] wait=120s
  List the files in src and summarize them.
```

### Durability

Agents belong to the Pi session that started them. When you quit Pi or it
crashes, agents pause. When you resume the session, for example with `pi -c`,
interrupted work continues and results that haven't arrived yet post into the
conversation. A tool call that can't safely repeat reports the interruption to
the agent instead.

Agents of sessions started with `--no-session` live in memory and end with
the session.

## 🧑‍💻 Agent profiles

A profile bundles reusable settings for agents. Create `.pi/agents/planner.md`:

```md
---
name: planner
description: Maps a codebase and proposes implementation plans
model: claude-opus-4-5
thinking: high
tools: [read, grep, find, ls]
skills: [architecture]
---

Map the relevant code and return a concrete implementation plan with file
paths. Do not edit files.
```

Then ask for it:

```text
Have a planner agent plan the caching layer.
```

Profile fields:

| Field | Meaning |
| --- | --- |
| `name` | Profile name. Required. |
| `description` | When to use the profile. Required. |
| `model` | Model as `provider/id` or `id`. Defaults to the session's model. |
| `thinking` | Thinking level. Defaults to the session's level. |
| `tools` | Tool allowlist. Defaults to `read`, `bash`, `edit`, `write`. |
| `skills` | Skills to apply. Without this field, the agent sees your skill catalog. An empty list disables skills. |

The Markdown body extends the agent's system prompt. Arguments that Pi passes
to `agent_spawn` override profile settings.

Pi-agents reads profiles from `~/.pi/agent/agents` and from the nearest
project `.pi/agents`. Project profiles win over user profiles with the same
name.

## ⚙️ Configuration

### Model guidance

Pi sees the models available to agents, each marked with a price tier from
`$` to `$$$`. Add notes about what models are good for in
`~/.pi/agent/pi-agents.json`:

```json
{
  "models": {
    "google/gemini-*-flash*": "fast triage, summaries, extraction",
    "claude-opus-*": "planning and final review"
  }
}
```

Patterns match provider-qualified model IDs. A pattern without `/` matches any
provider, and `*` is the only wildcard. The match with the longest literal
prefix wins. A trusted project's `.pi/pi-agents.json` wins ties with your
user configuration.

### Footer counters

With [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) installed,
pi-agents can show open agents by state, such as `✦ 2◉ 1●`. Enable the
`agents` widget through `/fancy-footer`.
