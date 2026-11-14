---
title: Agents' waits keep their timeout across restarts
type: bugfix
authors:
  - mavam
prs:
  - 124
created: 2026-11-14T08:40:31.822427Z
---

An agent's `agent_wait` now keeps its timeout across a restart. Previously, a restart while an agent waited for its agents started the timeout over. Waits and agents' jobs also no longer occupy running work while the agents they wait for work.
