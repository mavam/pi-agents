---
title: Control workflow runs over event-bus RPC
type: feature
authors:
  - mavam
  - codex
created: 2026-07-23T00:00:00Z
---

Other pi extensions can now ping pi-agents, start inline or saved workflows,
stop live runs, and list current-session run summaries through versioned,
request-correlated `pi.events` messages. RPC starts use the same validation,
project-trust rules, persistence, budgets, background notifications, and run
UI as existing trigger surfaces. Raw channels remain import-free, while the
new `pi-agents/api` subpath provides a typed client with timeout and listener
cleanup handling.
