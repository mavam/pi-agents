---
title: Compatibility with pi 0.69
type: bugfix
authors:
  - mavam
  - codex
created: 2026-04-23T06:58:20.623658Z
---

The extension now loads correctly with pi 0.69 and later.

Agent tools, workflow schemas, session refresh handling, skill prompt loading, and expand hints now use the current pi extension APIs, so agent orchestration continues to work after pi’s TypeBox, session event, and TUI updates.
