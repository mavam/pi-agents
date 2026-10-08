---
title: Start graphs of agents that pass results to each other
type: feature
authors:
  - mavam
prs:
  - 71
created: 2026-10-08T18:19:53.765689Z
---

Pi can now start a graph of agents that work together and pass their results to each other. Ask for it, for example "three agents review src/run, src/ui, and src/host, and a fourth merges their findings", and Pi uses the new `agent_spawn_graph` tool. Agents run in parallel, and an agent that waits for others starts once they finished and receives their final messages. Fan-outs with a merging agent, pipelines such as plan → implement → review, and diamonds all work.

Only the agents nothing waits for report back, as one message. With a single merging agent, Pi gets just its answer, attributed to it, and the results in between stay in the graph. When an agent fails, the agents waiting for it still start with the results that did arrive; an agent is skipped only when none of its inputs answered. A graph runs to the end by default; ask Pi to stop everything on the first failure instead. `agent_wait`, `agent_status`, and `agent_stop` accept graph names, and stopping a graph stops all of its agents.

The panel draws a graph as a tree: `○` marks an agent waiting for its inputs, and `←` names the agents whose results it receives. `/agents` shows each graph's shape, such as `map → {api, tests} → merge`. A graph's agents are ordinary agents: attach to them, message them, and keep talking to them after the graph finished. Graphs survive restarts like agents do: agents that already finished don't work again, and no agent gets its task twice.
