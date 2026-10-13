---
title: Deliver results of agents you interrupt and resume
type: bugfix
authors:
  - mavam
created: 2026-10-13T09:01:50.96854Z
---

If you interrupt an agent that works for Pi and then steer it to finish from the attach view, its next answer now goes to Pi. Before, the interrupt silently withdrew Pi's request, so the finished agent sat idle in the panel and Pi never got its result. While the answer waits for Pi, the panel shows `result queued`. To withdraw the request, stop the agent instead.
