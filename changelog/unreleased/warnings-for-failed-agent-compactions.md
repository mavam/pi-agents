---
title: Warnings for failed agent compactions
type: feature
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T07:16:42.755447Z
---

When an agent's context compaction fails, its line in the panel and `/agents` now shows `compaction failed`, and `/agents`, the attach view, and `agent_status` show the error. The agent keeps its state and goes on working. The warning stays until a later compaction succeeds, because the agent's context may overflow meanwhile.
