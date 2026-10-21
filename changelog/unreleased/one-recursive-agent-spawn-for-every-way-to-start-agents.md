---
title: One recursive agent_spawn for every way to start agents
type: breaking
authors:
  - mavam
prs:
  - 115
created: 2026-10-21T09:14:41.233172Z
---

`agent_spawn` is now the one tool for starting agents. Each call starts a graph of 1 to 12 agents, with `after` edges between them, and reports back as one message. A graph of one agent shows and reports as that agent. `agent_spawn_graph` is gone, and `agent_spawn` always takes an `agents` list:

```json
{ "agents": [{ "name": "scout", "job": "Map the API surface." }] }
```

Agents that may spawn now use the same tools as Pi: `agent_spawn`, `agent_wait`, and `agent_stop`, besides `agent_send` and `agent_status`. Spawning returns at once, and the results arrive as a message that starts with `[results]`, or from `agent_wait`. Spawned agents may spawn agents of their own when asked, up to three levels deep. An agent's job ends only with its first answer after the results of the agents it spawned, so Pi never gets an intermediate answer such as "checking with my agents".

Esc on an agent no longer stops its agents, and no longer ends its part in a graph: its job stays open until it answers again, and results of its agents wait for that answer. Stopping an agent stops every agent below it. When an agent's work fails, the agents whose results it still waited for stop.

The `delegate` argument and profile field are now called `spawn`; profiles with `delegate` still work. Agents that delegated in earlier versions keep running and are offered the new tools instead of `delegate_graph`.

An agent spawned by another agent can message its spawner, the agents spawned with it, and its own agents. Pi's agents still message each other.

Scripts get IDs for agents and graphs, and a finished graph's `outcome`: `succeeded`, `partial`, `failed`, or `stopped`.
