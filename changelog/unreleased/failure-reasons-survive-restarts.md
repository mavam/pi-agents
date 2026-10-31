---
title: Failure reasons survive restarts
type: bugfix
authors:
  - mavam
created: 2026-10-31T08:11:55.634401Z
---

An agent whose last turn ended without an answer now shows why after you restart Pi, for example a missing model, instead of only that it failed. `agent_status`, `/agents`, and the attach view show the same reason.
