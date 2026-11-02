# Graphs

Every `agent_spawn` starts one *group* of agents with one owned result.
Within that group, `after` edges form a dependency graph: agents can work
in parallel or build on each other's results. Agents use the same protocol
when they spawn their own groups.

## Graphs

One `agent_spawn` call starts a group of one to twelve agents that reports
one result to its owner. Agents without dependencies run in parallel. An
agent with `after` starts once its named agents finish and receives their
final messages with its job. A singleton uses the same group protocol and
has a group ID distinct from its agent ID, but shows and reports as the
agent. Common graph shapes:

| Shape | Example |
| --- | --- |
| Fan-out and merge | `{api, tests, host} → merge` |
| Pipeline | `plan → implement → review` |
| Diamond | `map → {api, tests} → merge` |

Only the agents nothing waits for contribute to the group's result, sent
as one message to Pi or to the agent that spawned the group. With a single
last agent, such as a merging one, the owner gets just its answer. The
intermediate results stay in the group, where you can attach to read them:

```text
● review › merge answered opus 6.2k
  Three issues stand out: …
⊗ host failed: rate limit exceeded
```

When an agent that others wait for fails, they still start with the results
that did arrive, and learn which agent failed. An agent is skipped only when
none of the agents it waits for answered.

By default a group runs to the end, even when an agent fails. Set
`failFast: true` to stop the remaining agents when one fails. Stopping a
group from Pi stops all of its agents and posts nothing; stopping a group
from its spawning agent still reports what finished to that agent.
Interrupting an agent keeps its job open until it answers again; stopping
it ends its part in the group. Neither stops the other agents, except that
stopping the agent of a singleton stops its group.

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

The agent spawns the way Pi does, one group per call, with the same `after`
edges, so one of its agents can merge the others' results. The group's
result goes to the agent that spawned it, never to Pi, as input starting
with `[results]` or as the result of its `agent_wait` call, never both. The
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

Both Pi and agents must call `agent_wait` directly, not from codemode.
Its result counts as received only once it is committed to the model's
conversation. A script could discard or truncate a nested return, or throw
before showing it, so a raw return isn't evidence that the model received
the result. Scripts can still compose spawning, messaging, status, and stop
calls; results arrive asynchronously.

Peer messages don't wake `agent_wait`. A child that needs clarification
from its waiting spawner must wait until that call ends; prefer asynchronous
results when the agents need to exchange questions.

A singleton group shows as its agent. Its group and agent IDs remain
separate: use the group ID to wait for or stop the group, and the agent ID
to address the agent. Spawned agents leave the panel once their spawner has
their results; you can still attach to them through `/agents`. Their full
names include their spawner's name, such as
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
- Stopping an agent stops its agents and theirs, including those that
  already finished. Stopping its group stops its agents too. A run that
  fails cancels only the groups it spawned whose results are still owed.
  Groups from earlier runs keep working, even if a later run fails.
  Stopping only one of its groups lets the agent go on with what finished.
- One call starts at most 12 agents. Each agent may spawn at most 24
  children over its entire lifetime, including completed and cancelled
  children. This is an intentional, nonreplenishing limit: finishing,
  stopping, or receiving results never frees capacity.
- At most 16 spawned agents have unfinished initial jobs at once in a
  session, including those still waiting on `after` dependencies. Later
  messages to agents whose initial jobs finished don't count toward this
  limit. The optional [working-agent cap](./configuration.md#working-agents)
  applies to those later turns too.
