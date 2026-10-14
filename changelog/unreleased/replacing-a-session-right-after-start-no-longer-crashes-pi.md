---
title: Replacing a session right after start no longer crashes Pi
type: bugfix
authors:
  - mavam
created: 2026-10-14T10:21:12.699767Z
---

Pi no longer exits when a session is replaced right after it starts, for example when an RPC client sends `new_session` shortly after spawning `pi --mode rpc`. Notices from pi-agents work that outlives its session, such as pruning old agent storage, are now discarded instead of failing on the replaced session's context.
