---
title: Show what a call started instead of stale states
type: change
authors:
  - mavam
prs:
  - 74
created: 2026-10-09T06:43:48.693959Z
---

A call that starts agents without waiting no longer shows a snapshot of their states that goes stale right away. A graph's call now draws the graph right below its title, with the agents each one waits for and their models, but without glyphs, times, or usage; the panel shows how the agents do. A single agent's call shows just its arguments and task, without repeating its name. Expanded, a graph's call shows each agent's task as its own paragraph, and long lines wrap under their indentation.
