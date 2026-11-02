---
title: Continue agents that crashes or errors stopped
type: change
authors:
  - mavam
created: 2026-10-31T08:11:53.205117Z
---

Work that crashes Pi over and over no longer stalls its agent until you retry it. Pi now ends the work instead: a tool call fails with an error the agent sees, and a turn fails the agent with a notice that names it. A model request that a crash interrupted counts as a failed attempt and retries under Pi's retry settings; with no retry left, the agent fails the same way.

The agent's job and Pi's message stay open, and the agents it spawned keep working. Select the agent in `/agents` and press `r` to continue it where it stopped. `r` continues any agent whose last turn ended without an answer, after a provider error or an interrupt too.
