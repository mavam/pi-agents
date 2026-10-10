---
title: Stop repeating the panel while a call waits for agents
type: change
authors:
  - mavam
prs:
  - 81
created: 2026-10-10T11:59:45.873465Z
---

A call that waits for agents no longer draws a live tree of their states that repeats the panel right below it. While a graph's call waits, it shows the graph it started, with the agents each one waits for and their models, as it does without waiting; `send` and `wait` calls show just the call. The panel shows how the agents do. Once waiting stops, the call shows the agents' states at that point: how they finished, or, after a timeout, Esc, or a message from you, where they were.
