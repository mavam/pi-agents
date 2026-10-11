---
title: Block for agents only with agent_wait
type: breaking
authors:
  - mavam
prs:
  - 84
created: 2026-10-11T11:52:48.307996Z
---

Only `agent_wait` blocks for agents now. `agent_spawn`, `agent_spawn_graph`, and `agent_send` no longer take `wait`: they return at once, and results arrive as messages. Pi often chose short waits, so a spawn reported `Timed out` while its agents kept working as intended. To block for results, call `agent_wait` after starting the agents, also in the same codemode script.
