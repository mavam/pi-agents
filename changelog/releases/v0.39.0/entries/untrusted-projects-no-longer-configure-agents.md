---
title: Untrusted projects no longer configure agents
type: bugfix
authors:
  - mavam
prs:
  - 121
created: 2026-11-02T14:18:18.556029Z
---

pi-agents now ignores the `piAgents` settings of a project you haven't trusted, as Pi ignores its other settings. Before, an untrusted project's `.pi/settings.json` could cap working agents, change how agents retry and compact, or set how long agent storage is kept.
