---
title: Improve live flow and agent summaries
type: change
authors:
  - mavam
  - codex
created: 2026-03-18T09:01:33.471Z
---

Foreground agent and workflow runs now keep a live summary visible instead of
falling back to the generic working indicator. The foreground renderer updates
in place with a spinner, token usage, wall-clock runtime, and a one-line
preview of the latest output.

The above-editor flows widget now stays visible only while flows are actively
running, and disappears once they finish so the final summaries live in the
conversation and notifications instead.

Live flow watching and flow summary rendering now use the same public spinner
cadence and frame sequence as pi's built-in loader.

This change also resets persisted flow-event history to a new event stream
format instead of carrying compatibility code for older session data.
