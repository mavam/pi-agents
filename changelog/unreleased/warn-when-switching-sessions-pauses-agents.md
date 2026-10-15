---
title: Warn when switching sessions pauses agents
type: bugfix
authors:
  - mavam
created: 2026-10-15T08:13:21.513855Z
---

Switching away from a session while its agents work or have results waiting
now names those agents in the new session, for you and for Pi, such as when you start a new session, resume another
one, or move to another worktree. They stay with the original session:
resume it to continue them and receive their results. Previously, they
disappeared without a word.
