---
title: Show what a call started instead of stale states
type: change
authors:
  - mavam
prs:
  - 74
created: 2026-10-09T06:21:52.94177Z
---

A call that starts agents without waiting, such as spawning a graph, no longer shows a snapshot of their states that goes stale right away. It now lists what it started: each agent with the agents it waits for and its model, without glyphs, times, or usage. The panel below shows how the agents do. Calls that report outcomes, such as waits and stops, still show the agents' states.
