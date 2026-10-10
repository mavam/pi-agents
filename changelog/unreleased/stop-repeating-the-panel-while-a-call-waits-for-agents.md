---
title: Stop repeating the panel while a call waits for agents
type: change
authors:
  - mavam
created: 2026-10-10T11:48:52.457447Z
---

A call that starts agents and waits for them no longer draws a live tree of their states that repeats the panel right below it. While the call waits, a graph's call shows the graph it started, with the agents each one waits for and their models, as it does without waiting, and the panel shows how the agents do. Once the wait ends, the call shows how the agents finished.
