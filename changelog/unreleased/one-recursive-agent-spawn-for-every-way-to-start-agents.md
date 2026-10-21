---
title: One recursive agent_spawn for every way to start agents
type: breaking
authors:
  - mavam
prs:
  - 115
created: 2026-10-21T11:26:48.741438Z
---

`agent_spawn` starts one group of 1 to 12 agents for Pi or for an agent permitted to spawn. Use `after` to pass results between agents within the group; the group reports one result to whoever started it. A group of one shows as its agent but retains a separate group ID:

```json
{
  "agents": [
    { "name": "scout", "job": "Map the API surface." },
    { "name": "review", "job": "Review the map.", "after": ["scout"], "spawn": true }
  ]
}
```

Agents permitted to spawn can use `agent_spawn`, `agent_send`, `agent_status`, `agent_wait`, and `agent_stop`. Spawning returns at once; the group result arrives as `[results]` input to the spawning agent or from a direct `agent_wait`, never both. Pi receives its groups' results as messages unless it calls `agent_wait` directly. Intermediate answers don't finish an agent's job while it is still owed results. `agent_wait` is model-only in both Pi and agents: codemode scripts cannot safely acknowledge results they might discard or truncate. Peer messages don't wake a blocked wait.

An interrupted agent keeps its children working and its job open for a corrective answer. Stopping it stops its entire subtree; a run that fails withdraws only the groups it spawned that still owe results. Agents can message their spawner, peers in their group, and their own children by name or reachable ID; Pi's agents can message each other. Spawning is bounded to three agent levels, 24 children per agent over its lifetime (including completed or cancelled children), and 16 unfinished initial spawned-agent jobs across a session. Later messages to finished agents don't use that fixed 16-agent allowance; the optional working-agent cap still applies.

This replaces earlier ways to start agents without compatibility shims. `agent_spawn_graph` and the agents' blocking `delegate_graph` are gone, `agent_spawn` takes only `agents` with a `job` for each agent, and profiles say `spawn: true` instead of `delegate: true`. Agents that earlier versions started can't spawn.
