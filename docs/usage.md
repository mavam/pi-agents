# Usage

Every agent keeps its conversation. Open `/agents`, pick any agent, even one
that finished hours ago, and keep talking to it like a regular Pi session.
Ask Pi to start agents: [see the example prompts](../README.md#-usage).

## Glossary

| Term | Meaning |
| --- | --- |
| Agent | A separate Pi agent with its own name, model, working directory, and conversation. It keeps its conversation after it answers. |
| Job | The instructions an agent starts with. They must stand on their own, because the agent doesn't see your conversation. |
| Message | Any later input to an agent. A message to a working agent *steers* it; a *follow-up* waits until the current answer is done. |
| Result | The agent's final message after its job or a message. |
| Group | One spawn's runtime-owned set of agents, with one result for whoever spawned it. A group of one looks like its agent, but has a separate group ID. |
| Graph | The `after` dependencies within a group: some agents run in parallel, others start after their inputs finish. |
| Spawned agent | An agent that another agent started for part of its job. Its group's result goes to that agent, not to Pi. |
| Profile | Reusable settings for agents, such as model, thinking level, tools, and instructions. |
| Attach | Open an agent's conversation to watch it and talk to it. |
| Stop | End an agent or group and remove it from the panel. Agents end on their own once their answer reaches their owner. Messaging an agent that ended starts it again. |

## States

An agent is in one of these states:

| State | Meaning |
| --- | --- |
| ◉ `working` | The agent works on its job or a message. |
| ◐ `queued` | The agent answered, and its result waits for Pi to take it. |
| ● `idle` | The agent answered and waits for messages. |
| ⊗ `failed` | The last answer ended with an error. |
| ⊘ `interrupted` | The last answer was interrupted before it finished. |
| ○ `waiting` | In a graph: the agent waits for the agents whose results it needs. |
| ⊖ `skipped` | In a graph: the agent never started because none of the agents it waited for answered. |
| ◌ `closed` | The agent ended: its answer reached its owner, or it was stopped. Messaging it starts it again. |

A group's row uses the same glyphs: it works until all of its agents finish,
then shows the state of its last agents: failed if one failed or was skipped,
interrupted if one was interrupted or stopped, and idle otherwise. Once its
result reaches its owner, it shows ◌ as well.

## Tools available to agents

Agents use `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and
`codemode`, plus your context files such as `AGENTS.md` and
[skills](#skills). They inherit your active tools from this set unless a
profile or spawn specifies others. They can't use MCP servers or tools
from other extensions.

`read` supports images. Codemode scripts can call the agent's other tools,
except `agent_wait`, which the agent's model must call directly. Scripts can
also use [`models`](https://pi.dev/docs/latest/codemode#models) to list models,
run classifiers, and generate images. These calls count toward the agent's
usage. Agents start agents of their own only when you let them
[spawn](./graphs.md#agents-that-spawn-agents).

## Skills

Agents see the skills Pi finds on disk: those in `~/.pi/agent/skills` and
`~/.agents/skills`, from packages and your settings, and the project's skills
when you trust the project. Like Pi, an agent loads a skill when its job
calls for it.

Agents don't get skills that exist only in the running session: those from
`--skill`, from packages passed on the command line, or from other
extensions. `--no-skills` doesn't apply to agents either. Agents pick up new
or changed skills after `/reload`.

To focus an agent, name its skills:

```text
Have an agent write the release notes with the technical-writing skill.
```

Pi then passes `skills` to the agent, which gets those skills in full instead
of the whole catalog. An empty list gives it none.

Skills marked `disable-model-invocation: true` stay yours: Pi doesn't see
them, so it can't hand them to agents either. To give agents such a skill,
name it in a [profile](./profiles.md#agent-profiles). Say you run a
`code-review` skill only with `/skill:code-review`. Create
`~/.pi/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Reviews changes with the code-review skill
tools: [read, bash, grep, find, ls]
skills: [code-review]
---
```

Then ask for reviewers:

```text
Have three reviewer agents review this branch: correctness, tests, and docs.
```

## Watch and talk to agents

A line above the editor shows how many agents are in each state:

```text
◉ 3 working ⊗ 1 failed · ← agents
```

Press ← in an empty editor, Ctrl+Q, or click the line to focus the panel.
It shows open agents and graphs, with their states, elapsed time, usage,
and progress. Graphs and spawned agents appear as trees; `after` names an
agent's dependencies:

```text
◉ reviewer explorer terra 1m32s 15.5k Using grep
⊗ docs sol 8.0k $0.02 rate limit exceeded
◉ review graph 1/4 40s 12.0k
├─ ● api terra 4.0k
├─ ◉ tests sol 40s 8.0k Using grep
├─ ◉ host sol 40s
└─ ○ merge after all opus
```

Agents and groups leave the panel once their results reach whoever spawned
them. Until Pi or the spawning agent can take a result, the panel shows
`◐ result queued`. Failed and interrupted agents stay until stopped.

When no agents are open, ← and Ctrl+Q open `/agents` instead. These
shortcuts apply only while Pi's prompt editor has focus.

In the focused panel:

| Key | Action |
| --- | --- |
| ↑ ↓ | Select an agent or graph. |
| Space | Fold or unfold a graph, or the agents an agent spawned. On a row inside one, fold what it sits in. |
| ⏎ | Attach to the agent, or to a graph's first agent. |
| Click | Attach like ⏎; a message attaches to its recipient. Needs Pi's fullscreen mode, its default. |
| Tab | Open `/agents` at the same row. Tab cycles the panel, `/agents`, and `/messages`; Shift+Tab goes back. |
| `s` | Stop the agent, or the graph with its agents. Pi asks first when it still works. |
| Esc or → | Go back to the editor. Other keys go back too and act there, so typed or pasted text lands in the editor. |

Attaching opens the agent's conversation. The editor names the agent and
sends your input to it:

| Key | Action |
| --- | --- |
| ⏎ | Prompt an idle agent or steer a working one. An agent that waits for the agents its job needs takes input once it starts. |
| Alt+⏎ | Queue a follow-up after the current answer. |
| Esc | Interrupt a working agent; queued messages return to the editor. Go back from an idle one when the editor is empty. |
| Ctrl+O | Expand or collapse tool output. |
| ← or Ctrl+D | Detach when the editor is empty. |
| Shift+↑ ↓, Shift+PgUp/PgDn | Scroll. |
| Mouse wheel | Scroll in fullscreen mode, with the pointer over the attached view. |

Messages you send while attached stay between you and the agent. Their
results don't post into the parent conversation, with one exception: when
you interrupt an agent while it works on a job or message from Pi and then
steer it to finish, its next answer goes to Pi, since Pi still expects one.
Stop the agent instead if Pi should get nothing. The same holds for a
graph's agent, whose job in the graph stays open until it answers again,
and for an agent's own agents, which keep working after an interrupt.

Open `/agents` to attach to finished or stopped agents, including agents
from completed graphs. Their conversations remain available after you
resume a session.

Switching sessions pauses the original session's agents. Resume that
session to continue them and receive results; they don't follow you to
the new session.

## Commands

| Command | Action |
| --- | --- |
| `/agents` | Browse all agents and graphs, including ended ones, with their jobs and latest results. Attach to, fold, or stop them. |
| `/agent <name>` | Attach to an agent. |
| `/messages` | Read and filter the messages agents sent each other, newest first. |

## Tools

Pi uses these tools to work with agents:

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start one group of 1 to 12 agents, optionally with `after` dependencies or permission to spawn. |
| `agent_send` | Message an agent: prompt, steer, or queue a follow-up. |
| `agent_wait` | Block until agents or groups answer and return their results. |
| `agent_status` | Show agent and group states. |
| `agent_stop` | Stop an agent or a group. |

`agent_spawn` always takes an `agents` list, even for one agent. Each entry
uses `job` for its instructions and may set `spawn: true` to permit children.
Use `after` with names from the same call to make a dependency graph:

```json
{
  "agents": [
    { "name": "scout", "job": "Map the API surface." },
    { "name": "review", "job": "Review the map.", "after": ["scout"] }
  ]
}
```

To permit recursive spawning:

```json
{ "agents": [{ "name": "scout", "job": "Map the API surface.", "spawn": true }] }
```

`agent_spawn` and `agent_send` return at once. Each spawn owns one group and
reports one result to its caller: Pi receives a message starting its next turn,
or a spawning agent receives `[results]` input. The group's ID and each agent's
ID are different, even for a group of one. A singleton shows as its agent;
use the agent ID to address that agent, or the group ID to wait for or stop
the spawn as a unit. Agents that may spawn get `agent_spawn`, `agent_wait`,
and `agent_stop` for their own agents, besides `agent_send` and
`agent_status`.

Only `agent_wait` blocks, up to its `timeout` in seconds. Use it when a
turn must combine results, or in a single-shot run such as `pi --print`,
which would otherwise end before agents report. Results returned by a wait
don't also post as messages. Cancelling a wait or sending Pi a message ends
the wait, not the agents' work.

Both in Pi and inside agents, `agent_wait` is a direct-model tool,
unavailable to codemode. Peer messages don't end that wait, including a
child's request for clarification; use asynchronous results when agents
need to discuss the work. See [agents that spawn agents](./graphs.md#agents-that-spawn-agents).

With [codemode](https://pi.dev/docs/latest/codemode), you can compose
`agent_spawn`, `agent_send`, `agent_status`, and `agent_stop`. Start jobs
whose results belong together in one group, with a final merging agent if
needed, then let the results arrive as messages or call `agent_wait`
directly. A nested script could discard, truncate, or lose a wait's return
before the model sees it; direct waits avoid acknowledging unseen results.

Pi's structured tool results include group and agent IDs and states, and a
finished group's `outcome`: `succeeded`, `partial`, `failed`, or `stopped`.
A wait for an agent whose singleton group hasn't reported yet returns the
group. Names in `pending` keep working, and their results arrive as
messages.
