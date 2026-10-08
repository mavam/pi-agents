---
title: Start groups of agents that report back together
type: feature
authors:
  - mavam
created: 2026-10-08T14:10:32.896311Z
---

Pi can now start a group of agents that work in parallel on related tasks and report back together. Ask for it, for example "start a group of three agents to review src/run, src/ui, and src/host", and Pi uses the new `agent_spawn_group` tool. Once every agent is done, their final messages arrive as one message, so Pi can merge them in one go. With `wait`, Pi blocks for the results instead.

A group waits for all of its agents by default. Ask Pi to stop the others as soon as one fails, and they stop instead. `agent_wait`, `agent_status`, and `agent_stop` accept group names, and stopping a group stops all of its agents. Interrupting a single agent doesn't stop its group.

The panel shows a group's progress with its agents indented below it, and `/agents` lists groups with their agents. A group's agents are ordinary agents: attach to them, message them, and keep talking to them after the group finished. Groups survive restarts like agents do: after you resume a session, agents that already finished don't work again, and the group's result arrives once.
