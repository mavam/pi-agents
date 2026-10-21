# Graphs

Graphs connect agents that work in parallel or build on each other's
results; agents that delegate use graphs for their helpers.

## Graphs

A graph starts two to twelve agents that work together. Agents run in
parallel, and an agent that waits for others starts once they finished and
receives their final messages with its job. Common shapes:

| Shape | Example |
| --- | --- |
| Fan-out and merge | `{api, tests, host} → merge` |
| Pipeline | `plan → implement → review` |
| Diamond | `map → {api, tests} → merge` |

Only the agents nothing waits for report back to Pi, as one message. With a
single last agent, such as a merging one, Pi gets just its answer, and the
results in between stay in the graph, where you can attach to read them:

```text
● review › merge answered opus 6.2k
  Three issues stand out: …
⊗ host failed: rate limit exceeded
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

Edges carry final messages; there are no references, schemas, loops, or
conditions. For repeated rounds, such as review and fix, message the agents
again.

## Agents that delegate

An agent that may delegate splits its own job while it works: it starts
helper agents, waits for them, and continues with their results. This covers
work whose shape only shows up on the way, such as one helper per file the
agent finds. Ask Pi for it, or set `delegate: true` in a profile.

Helpers form a graph like the ones Pi starts, with the same edges, so a
helper can merge the others' results. Their results go to the agent that
started them, never to Pi, and only that agent's final answer reports back.
The panel draws the helpers below their agent, which shows their progress:

```text
◉ mapper haiku 17s delegating helpers 1/4
└─ ◉ helpers graph 1/4 10s 13.0k
   ├─ ● models haiku 3.1k
   ├─ ◉ paths haiku 10s
   ├─ ◉ skills haiku 10s
   └─ ○ merge after all haiku
```

Helpers leave the panel once their agent has their results; you can still
attach to them through `/agents`. Their full names include their agent's
name, such as `mapper.models`.

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
