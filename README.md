# 🤖 pi-agents

Give [Pi](https://pi.dev) durable, named agents. Delegate a task, keep working
while the agent runs, and get its result back as a message. Watch any agent
live, talk to it, or stop it. Agents survive crashes and restarts.

Agents run inside your Pi process on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which
checkpoints every step. When you resume a session, interrupted agents continue
where they stopped.

<img src="demo/agents.gif" width="840" alt="Pi starts an audit graph on three models whose reviewers delegate one helper per file, shows the live tree and the merged findings, browses the results in /agents, and spawns three agents that tell jokes">

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

```text
Start a graph: three agents review src/run, src/ui, and src/host, and a
fourth merges their findings into one list of issues.
```

```text
Start an agent that may delegate: it finds every module under src, has one
helper review each, and returns one merged review.
```

Pi starts agents only when you ask for delegation. An agent's result is its
final message. Results of agents that Pi doesn't wait for arrive later as
messages in your conversation. In a graph, agents pass their results to each
other, and Pi gets one message at the end.

Every agent keeps its conversation. Open `/agents`, pick any agent, even one
that finished hours ago, and keep talking to it like a regular Pi session.

### Architecture

Agents run inside your Pi process. Pi-agents keeps one pi-durable harness per
Pi session. Each agent is a conversation in that harness, and each graph a
task that starts its agents and passes their results along:

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
│  │   ◉ agent     ╭─ graph ─────────────────────────╮          │  │
│  │               │ ● map ─┬─▶ ◉ core ─┬─▶ ○ report │          │  │
│  │   ● agent     │        └─▶ ◉ ui ───┘            │          │  │
│  │               │            └─ ◉ ◉ ◉ helpers     │          │  │
│  │   …           ╰─────────────────────────────────╯          │  │
│  │                                                            │  │
│  │   agents are conversations; a graph is a task that starts  │  │
│  │   them in order and passes their results on                │  │
│  ╰─────────────────────────────┬──────────────────────────────╯  │
╰────────────────────────────────┼─────────────────────────────────╯
                                 │ checkpoint every step
                                 ▼
                   ╭───────────────────────────╮
                   │  ▤ JSONL, one per session │
                   ╰───────────────────────────╯
```

A graph owns its agents, so stopping a graph reaches all of them. An agent
that delegates starts its helpers as a graph of its own, owned by the call
that waits for them. Because pi-durable checkpoints every step, a resumed
session continues where its agents and graphs stopped. Agents use your Pi
logins and models, so they need no separate setup.

### Glossary

| Term | Meaning |
| --- | --- |
| Agent | A separate Pi agent with its own name, model, working directory, and conversation. It keeps its conversation after it answers. |
| Task | The first message an agent gets. It must stand on its own, because the agent doesn't see your conversation. |
| Message | Any later input to an agent. A message to a working agent *steers* it; a *follow-up* waits until the current answer is done. |
| Result | The agent's final message after a task or message. |
| Graph | Agents that work together: some in parallel, some after others, receiving their results. Pi gets one message at the end. |
| Helper | An agent that another agent started for part of its task. Its result goes to that agent, not to Pi. |
| Profile | Reusable settings for agents, such as model, thinking level, tools, and instructions. |
| Attach | Open an agent's conversation to watch it and talk to it. |
| Stop | End an agent or graph and remove it from the panel. Agents end on their own once their answer reaches Pi. Messaging an agent that ended starts it again. |

An agent is in one of these states:

| State | Meaning |
| --- | --- |
| ◉ `working` | The agent works on a task or message. |
| ● `idle` | The agent answered and waits for messages. |
| ✗ `failed` | The last answer ended with an error. |
| ⊘ `interrupted` | The last answer was interrupted before it finished. |
| ○ `waiting` | In a graph: the agent waits for the agents whose results it needs. |
| ⊖ `skipped` | In a graph: the agent never started because none of the agents it waited for answered. |

A graph uses the same glyphs: it works until all of its agents finished, then
shows the state of its last agents: failed if one failed or was skipped,
interrupted if one was interrupted or stopped, and idle otherwise.

Agents use Pi's tools `read`, `bash`, `edit`, `write`, `grep`, `find`, and
`ls`, along with your context files such as `AGENTS.md` and your
[skills](#skills). They can't use MCP servers or tools from other extensions,
and they start other agents only when you let them delegate.

### Skills

Agents see the skills Pi finds on disk: those in `~/.pi/agent/skills` and
`~/.agents/skills`, from packages and your settings, and the project's skills
when you trust the project. Like Pi, an agent loads a skill when its task
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
name it in a [profile](#-agent-profiles). Say you run a `code-review` skill
only with `/skill:code-review`. Create `~/.pi/agent/agents/reviewer.md`:

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

### Watch and talk to agents

A panel above the editor shows one line per open agent or graph, with a
graph's agents below it as a tree. The glyph shows the state, working agents
show how long ago they started, a graph shows how many of its agents
finished, and `←` names the agents whose results an agent receives:

```text
◉ reviewer · explorer · terra · 1m32s · 15.5k · Using grep
✗ docs · sol · 8.0k · $0.02 · rate limit exceeded
◉ review · graph 1/4 · 40s · 12.0k
├─ ● api · terra · 4.0k
├─ ◉ tests · sol · 40s · 8.0k · Using grep
├─ ◉ host · sol · 40s
└─ ○ merge ← api, tests, host · opus
```

An agent leaves the panel once its answer reaches Pi, and a graph once its
result does. Pi takes results only between turns and while you aren't
attached, so until then an agent that answered Pi shows `●` in the accent
color instead of green and says `result queued`, and so does a graph:

```text
● series-review · sol · 1.1m · $0.42 · result queued
```

Failed and interrupted agents stay until you or Pi stop them.

Press ← in an empty editor or Ctrl+Q to focus the panel. When no agents are
open, they open `/agents` instead. Then:

| Key | Action |
| --- | --- |
| ↑ ↓ | Select an agent or graph. |
| Space | Fold or unfold a graph, or an agent's helpers. On a row inside one, fold what it sits in. |
| ⏎ | Attach to the agent, or to a graph's first agent. |
| Tab | Open `/agents` at the same row. Tab there returns to the panel while agents are open. |
| `s` | Stop the agent, or the graph with its agents. Pi asks first when it still works. |
| Esc | Return to the editor. |

Attaching shows the agent's conversation with Pi's own message and tool
rendering. The editor then talks to the agent:

| Key | Action |
| --- | --- |
| ⏎ | Prompt an idle agent or steer a working one. |
| Alt+⏎ | Queue a follow-up after the current answer. |
| Esc | Interrupt a working agent. Queued messages return to the editor. |
| Ctrl+O | Expand or collapse tool output. |
| ← | Detach when the editor is empty. |
| Shift+↑ ↓, Shift+PgUp/PgDn | Scroll. |

Messages you send while attached stay between you and the agent. Their
results don't post into the parent conversation.

You can attach to any agent, not only the ones in the panel. `/agents` shows
how long each agent and graph ran, from its start until it last finished;
that time stays put once it finished. Agents that
finished or were stopped keep their whole conversation: open `/agents`, select
one, and continue where it left off; its time then counts on from its start,
pauses included. This also works for a graph's agents
after the graph finished, and after you resume a session.

### Graphs

A graph starts two to twelve agents that work together. Agents run in
parallel, and an agent that waits for others starts once they finished and
receives their final messages with its task. Common shapes:

| Shape | Example |
| --- | --- |
| Fan-out and merge | `{api, tests, host} → merge` |
| Pipeline | `plan → implement → review` |
| Diamond | `map → {api, tests} → merge` |

Only the agents nothing waits for report back to Pi, as one message. With a
single last agent, such as a merging one, Pi gets just its answer, and the
results in between stay in the graph, where you can attach to read them:

```text
● review › merge answered · opus · 6.2k
  Three issues stand out: …
✗ host failed: rate limit exceeded
```

When an agent that others wait for fails, they still start with the results
that did arrive, and learn which agent failed. An agent is skipped only when
none of the agents it waits for answered.

By default a graph runs to the end, even when an agent fails. Ask Pi to stop
everything as soon as one agent fails, and the remaining agents stop instead.
Stopping a graph stops all of its agents and posts nothing. Interrupting or
stopping a single agent doesn't stop its graph or the graph's other agents.

A graph's agents are ordinary agents: attach to them, message them, and keep
talking to them after the graph finished. A message to a graph's agent while
the graph works joins its work; if the agent answers it separately, that
answer arrives after the graph's result. A queued follow-up to a graph's agent
holds back the graph until the agent answered it as well.

Graphs replace the workflow language of earlier versions with something
smaller: edges carry final messages, and there are no references, schemas,
loops, or conditions. For repeated rounds, such as review and fix, Pi can
message the agents again.

### Agents that delegate

An agent that may delegate splits its own task while it works: it starts
helper agents, waits for them, and continues with their results. This covers
work whose shape only shows up on the way, such as one helper per file the
agent finds. Ask Pi for it, or set `delegate: true` in a profile.

Helpers form a graph like the ones Pi starts, with the same edges, so a
helper can merge the others' results. Their results go to the agent that
started them, never to Pi, and only that agent's final answer reports back.
The panel draws the helpers below their agent, which shows their progress:

```text
◉ mapper · haiku · 17s · delegating · helpers 1/4
└─ ◉ helpers · graph 1/4 · 10s · 13.0k
   ├─ ● models · haiku · 3.1k
   ├─ ◉ paths · haiku · 10s
   ├─ ◉ skills · haiku · 10s
   └─ ○ merge ← models, paths, skills · haiku
```

Helpers leave the panel once their agent has their results; `/agents` keeps
them, and you can attach to them like any agent. A helper's full name starts
with its agent's, such as `mapper.models`; the tree leaves that part out
below the agent, and the divider over its details in `/agents` shows it.

- Helpers run on their agent's model, thinking level, and working directory
  unless the agent picks others, and get only tools their agent has.
- Helpers see your skills like any agent, and the agent can name skills for
  them the way Pi does.
- Helpers can't delegate themselves.
- Esc on the agent stops its helpers too, and so does stopping a graph the
  agent belongs to. Stopping only the helpers lets the agent go on with what
  they finished.
- While an agent waits for its helpers, a message you send it waits until
  they finish. Press Esc to stop them instead.
- One call starts at most 12 helpers, an agent at most 24 in total, and at
  most 16 helpers work at once in a session.

### Commands

| Command | Action |
| --- | --- |
| `/agents` | Browse all agents and graphs, including ended ones, with their tasks and latest results. Attach to, fold, or stop them. |
| `/agent <name>` | Attach to an agent. |

### Tools

Pi uses these tools to work with agents:

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start an agent on a task, optionally waiting for its result, and optionally letting it delegate. |
| `agent_spawn_graph` | Start a graph of agents, optionally waiting for its result. |
| `agent_send` | Message an agent: prompt, steer, or queue a follow-up. |
| `agent_wait` | Block until agents or graphs answer and return their results. |
| `agent_status` | Show agent and graph states. |
| `agent_stop` | Stop an agent or a graph. |

`agent_spawn`, `agent_spawn_graph`, and `agent_send` can also block for the
result: their `wait` argument sets the most seconds to wait. A result that a
wait returns doesn't post again as a message. Cancelling a wait leaves the
agents working, and so does a message you send to Pi while it waits: Pi
stops waiting and answers you right away.

With [codemode](https://pi.dev/docs/latest/codemode), scripts get the
results as data instead of text: an agent's `name`, `state`, and `result`
or `error`, a graph's `state` and how each of its agents ended its task,
and the names a wait leaves `pending`. A script can start agents, wait for
all of them, and pick out what it needs before Pi reads anything:

```js
const names = ["api", "tests", "docs"];
await Promise.all(
  names.map((name) => tools.agent_spawn({ name, task: `Review the ${name}.` })),
);
const { agents, pending } = await tools.agent_wait({ names, timeout: 600 });
return { failed: agents.filter((a) => a.state === "failed"), pending };
```

Each tool call shows the arguments Pi chose on a dim line below it:

```text
✦ spawn lister
  profile=explorer thinking=low tools=[read,ls] wait=120s
  List the files in src and summarize them.
```

A call that fails shows the reason below it, for example `terminated` when
the model's response broke off before Pi could run the call.

### Durability

Agents belong to the Pi session that started them. When you quit Pi or it
crashes, agents pause. When you resume the session, for example with `pi -c`,
interrupted work continues and results that haven't arrived yet post into the
conversation. A result has arrived once Pi saved it in the session, so a crash
never loses one; a result that Pi showed but hadn't saved yet posts again, and
after a crash, so may a result that a codemode script waited for. A graph
continues too: its agents that already finished don't work again, and no
agent gets its task twice. A tool call that can't safely repeat reports the
interruption to the agent instead.

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
| `skills` | Skills to apply in full, including those only you can invoke. Without this field, the agent sees your skill catalog. An empty list disables skills. |
| `delegate` | Whether agents of this profile can start helper agents. Defaults to `false`. |

The Markdown body extends the agent's system prompt. Arguments that Pi passes
to `agent_spawn` override profile settings.

Pi-agents reads profiles from `~/.pi/agent/agents` and, when you trust the
project, from `.pi/agents` in the directory where you started Pi, the same
place Pi reads the project's skills and settings from. Project profiles win
over user profiles with the same name.

## ⚙️ Configuration

### Models

An agent runs on your session's model unless Pi or a profile picks another.
Models resolve like `pi --model`: `sonnet` picks the newest Sonnet you have
credentials for, and an exact ID such as `claude-sonnet-4-6` picks that
version. Run `pi --list-models` to see what's available.

Pi learns which names are models from your scoped models, the ones you pick
with `/scoped-models` or `--models`. Scope the models you want agents to use,
and Pi picks them by name: "spawn a Luna agent" runs on your scoped Luna.

### Concurrent requests

Agents work in parallel and each sends its own model requests. A model
server that handles one request at a time, such as a local LLM, can fall
behind or time out. Cap how many requests agents send at once in
`~/.pi/agent/settings.json` or your project's `.pi/settings.json`:

```json
{
  "piAgents": {
    "maxConcurrentRequests": 1
  }
}
```

Requests over the cap wait their turn in order, and agents keep working on
tools in the meantime. Agents, graphs, and helpers all share the cap. Your
session's own requests don't count toward it. Without the setting, requests
aren't limited. Restart Pi after changing it.

### Footer counters

With [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) installed,
pi-agents can show open agents by state, such as `✦ 2◉ 1●`. Enable the
`agents` widget through `/fancy-footer`.
