---
title: Pi 1.5.0 required
type: breaking
authors:
  - mavam
prs:
  - 119
created: 2026-10-31T08:16:33.434111Z
---

pi-agents now requires Pi 1.5.0 or later, so update Pi before updating pi-agents. Sessions keep their agents across the update. Work that stalled after repeated crashes ends when its session opens: its agent fails, and so does a graph waiting for it. Press `r` in `/agents` to continue the agent. Going back to an earlier pi-agents version afterwards isn't supported: it can't read the state of agents this version ran, and shows their unfinished work as stalled.
