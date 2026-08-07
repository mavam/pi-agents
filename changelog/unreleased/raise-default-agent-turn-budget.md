---
title: Higher default agent turn budget
type: bugfix
authors:
  - mavam
  - codex
created: 2026-08-07T08:50:00Z
---

Delegated agents may now use up to 250 assistant turns by default, up from 100.
This gives long-running review and repair workflows enough room to inspect
large changes, run checks, and submit their results without being cut off by
the default per-agent turn budget. Explicit `maxTurns` limits continue to
override the default.
