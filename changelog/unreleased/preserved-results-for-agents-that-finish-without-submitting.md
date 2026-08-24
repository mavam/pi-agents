---
title: Preserved results for agents that finish without submitting
type: bugfix
authors:
  - mavam
created: 2026-08-24T12:55:45.26245Z
---

A delegated agent that completed its work but never packaged it through the
result-submission tool previously failed with a generic "finished without
submitting a result" error, and the finished report was lost.

Workflow runs now recover and preserve that work:

- A settled agent that produced output without submitting it gets one bounded
  in-band nudge to package what it already has, without redoing the
  assignment.
- If the agent still ends without submitting, its final response is preserved
  as the node's partial result and stays retrievable via `workflow_result`.
- The node failure now carries a `result-contract` failure kind, so
  `workflow_inspect` distinguishes an output-packaging failure from a task
  failure.
