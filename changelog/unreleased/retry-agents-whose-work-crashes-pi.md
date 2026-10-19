---
title: Retry agents whose work crashes Pi
type: feature
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T07:59:01.839941Z
---

When Pi crashes or is killed several times in a row while an agent works, without the agent getting any further, the agent's work no longer resumes by itself on every restart. The agent shows `stalled after repeated crashes` instead, in the panel, `/agents`, the attach view, and `agent_status`. Select it in `/agents` and press `r` to retry it, or `s` to stop it. Agents whose unfinished work this version of pi-agents can't run show as stalled too.
