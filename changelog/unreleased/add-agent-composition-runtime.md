---
title: Add agent workflow runtime
type: feature
authors:
  - mavam
  - codex
created: 2026-03-15T00:00:00Z
---

Add a subprocess-backed agent workflow runtime with a new `workflow` tool,
persistent run state, and run inspection commands.

The initial runtime supports JSON-defined `spawn`, `sequence`, `fork`, `join`,
and `loop` flows, plus budget checks and session reconstruction.
