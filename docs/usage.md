# Usage

Every agent keeps its conversation. Open `/agents`, pick any agent, even one
that finished hours ago, and keep talking to it like a regular Pi session.
Ask Pi to delegate: [see the example prompts](../README.md#-usage).

## Glossary

| Term | Meaning |
| --- | --- |
| Agent | A separate Pi agent with its own name, model, working directory, and conversation. It keeps its conversation after it answers. |
| Job | The instructions an agent starts with. They must stand on their own, because the agent doesn't see your conversation. |
| Message | Any later input to an agent. A message to a working agent *steers* it; a *follow-up* waits until the current answer is done. |
| Result | The agent's final message after its job or a message. |
| Graph | Agents that work together: some in parallel, some after others, receiving their results. Pi gets one message at the end. |
| Helper | An agent that another agent started for part of its job. Its result goes to that agent, not to Pi. |
| Profile | Reusable settings for agents, such as model, thinking level, tools, and instructions. |
| Attach | Open an agent's conversation to watch it and talk to it. |
| Stop | End an agent or graph and remove it from the panel. Agents end on their own once their answer reaches Pi. Messaging an agent that ended starts it again. |

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
| ◌ `closed` | The agent ended: its answer reached Pi, or it was stopped. Messaging it starts it again. |

A graph uses the same glyphs: it works until all of its agents finished, then
shows the state of its last agents: failed if one failed or was skipped,
interrupted if one was interrupted or stopped, and idle otherwise. Once its
result reaches Pi, it shows ◌ as well.

## Tools available to agents

Agents use `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and
`codemode`, plus your context files such as `AGENTS.md` and
[skills](#skills). They inherit your active tools from this set unless a
profile or spawn specifies others. They can't use MCP servers or tools
from other extensions.

`read` supports images. Codemode scripts can call the agent's other tools
and use [`models`](https://pi.dev/docs/latest/codemode#models) to list models,
run classifiers, and generate images. These calls count toward the agent's
usage. Agents start helpers only when you let them
[delegate](./graphs.md#agents-that-delegate).

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
and progress. Graphs and helpers appear as trees; `after` names an agent's
dependencies:

```text
◉ reviewer explorer terra 1m32s 15.5k Using grep
⊗ docs sol 8.0k $0.02 rate limit exceeded
◉ review graph 1/4 40s 12.0k
├─ ● api terra 4.0k
├─ ◉ tests sol 40s 8.0k Using grep
├─ ◉ host sol 40s
└─ ○ merge after all opus
```

Agents and graphs leave the panel once their results reach Pi. Until Pi
can take a result—between turns and while you aren't attached—it shows
`◐ result queued`. Failed and interrupted agents stay until stopped.

When no agents are open, ← and Ctrl+Q open `/agents` instead. These
shortcuts apply only while Pi's prompt editor has focus.

In the focused panel:

| Key | Action |
| --- | --- |
| ↑ ↓ | Select an agent or graph. |
| Space | Fold or unfold a graph, or an agent's helpers. On a row inside one, fold what it sits in. |
| ⏎ | Attach to the agent, or to a graph's first agent. |
| Click | Attach like ⏎; a message attaches to its recipient. Needs Pi's fullscreen mode, its default. |
| Tab | Open `/agents` at the same row. Tab cycles the panel, `/agents`, and `/messages`; Shift+Tab goes back. |
| `s` | Stop the agent, or the graph with its agents. Pi asks first when it still works. |
| Esc or → | Go back to the editor. Other keys go back too and act there, so typed or pasted text lands in the editor. |

Attaching opens the agent's conversation. The editor names the agent and
sends your input to it:

| Key | Action |
| --- | --- |
| ⏎ | Prompt an idle agent or steer a working one. |
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
Stop the agent instead if Pi should get nothing. A graph's agent is
different: interrupting it ends its part in the graph, which goes on
without it.

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
| `agent_spawn` | Start an agent on a job, optionally letting it delegate. |
| `agent_spawn_graph` | Start a graph of agents. |
| `agent_send` | Message an agent: prompt, steer, or queue a follow-up. |
| `agent_wait` | Block until agents or graphs answer and return their results. |
| `agent_status` | Show agent and graph states. |
| `agent_stop` | Stop an agent or a graph. |

`agent_spawn`, `agent_spawn_graph`, and `agent_send` return at once.
Results arrive as messages that start Pi's next turn. A graph groups its
results into one message. Pi receives complete results and error messages
without a size limit.

Only `agent_wait` blocks, up to its `timeout` in seconds. Use it when a
turn must combine results, or in a single-shot run such as `pi --print`,
which would otherwise end before agents report. Results returned by a wait
don't also post as messages. Cancelling a wait or sending Pi a message ends
the wait, not the agents' work.

With [codemode](https://pi.dev/docs/latest/codemode), scripts get the
results as data instead of text: an agent's `name`, `state`, and `result`
or `error`, a graph's `state` and how each of its agents ended its job,
and the names a wait leaves `pending`. A script that waits blocks Pi like
a direct wait, so it pays off when the script combines the results in code
before Pi reads anything:

```js
const names = ["api", "tests", "docs"];
await Promise.all(
  names.map((name) => tools.agent_spawn({ name, job: `Review the ${name}.` })),
);
const { agents, pending } = await tools.agent_wait({ names, timeout: 600 });
return { failed: agents.filter((a) => a.state === "failed"), pending };
```

Names in `pending` keep working, and their results arrive as messages.
