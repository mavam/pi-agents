# Graphs

Graphs connect agents that work in parallel or build on each other's
results. Every spawn starts one graph, and agents that may spawn use graphs
for their own agents.

## Graphs

One `agent_spawn` call starts a graph of one to twelve agents that report
back as one result. Agents run in parallel, and an agent that waits for
others starts once they finished and receives their final messages with its
job. A graph of one agent is just that agent: it shows and reports as the
agent. Common shapes:

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
Stopping a graph stops all of its agents and posts nothing. Interrupting an
agent keeps its job open until it answers again; stopping it ends its part
in the graph. Neither stops the graph or its other agents, except that
stopping the agent of a graph of one stops that graph.

A graph's agents are ordinary agents: attach to them, message them, and keep
talking to them after the graph finished. A message to a graph's agent while
the graph works joins its work; if the agent answers it separately, that
answer arrives after the graph's result. A queued follow-up to a graph's agent
holds back the graph until the agent answered it as well. An agent that still
waits for the agents its job needs takes no messages until it starts.

Edges carry final messages; there are no references, schemas, loops, or
conditions. For repeated rounds, such as review and fix, message the agents
again.

## Agents that spawn agents

An agent that may spawn splits its own job while it works: it starts agents
of its own, keeps working or ends its turn, and continues once their results
arrive. This covers work whose shape only shows up on the way, such as one
agent per file it finds. Ask Pi for it, or set `spawn: true` in a profile.

The agent spawns the way Pi does, one graph per call, with the same edges,
so one of its agents can merge the others' results. The graph's result goes
to the agent that spawned it, never to Pi, as a message that starts with
`[results]`, or as the result of its `agent_wait` call, never both. The
agent's job ends only with its first answer after those results: an answer
before them, such as "checking with my agents", doesn't reach Pi. The panel
draws an agent's agents below it:

```text
◉ mapper haiku 17s spawned group 1/4
└─ ◉ group graph 1/4 10s 13.0k
   ├─ ● models haiku 3.1k
   ├─ ◉ paths haiku 10s
   ├─ ◉ skills haiku 10s
   └─ ○ merge after all haiku
```

A graph of one agent shows as that agent. Spawned agents leave the panel
once their agent has their results; you can still attach to them through
`/agents`. Their full names include their agent's name, such as
`mapper.models`.

- Spawned agents run on their agent's model, thinking level, and working
  directory unless the agent picks others, and get only tools their agent
  has.
- They see your skills like any agent, and the agent can name skills for
  them the way Pi does.
- They may spawn agents of their own only when their agent asks for it.
  Agents nest at most three levels deep: Pi's agents, theirs, and those
  agents' agents, which can't spawn.
- An agent can message the agent that spawned it, the agents spawned with
  it, and the agents it spawned. Pi's agents can message each other.
- Esc on an agent corrects it and leaves its agents working. Their results
  wait until the agent answered again, so they don't restart work you just
  interrupted.
- Stopping an agent stops its agents and theirs, also those that already
  finished, and so does stopping a graph it belongs to. When its work
  fails, the agents whose results it still waited for stop. Stopping only
  one of its graphs lets the agent go on with what finished.
- One call starts at most 12 agents, and an agent at most 24 in total. At
  most 16 spawned agents work on their jobs at once in a session; agents
  you or their agent message again later don't count.
