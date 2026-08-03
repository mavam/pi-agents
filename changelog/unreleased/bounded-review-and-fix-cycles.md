---
title: Bounded pre-checked iteration
type: feature
authors:
  - mavam
  - claude
  - codex
prs:
  - 25
created: 2026-08-01T08:48:03.588482Z
---

Workflows can now use a bounded, pre-checked `while` node to carry JSON state
through zero or more iterations:

```yaml
kind: while
on: "{initial_state}"
condition:
  eq: [status, pending]
max: 3
body:
  kind: agent
  task: "Advance {current} in round {iteration}."
  output: json
```

The node checks `condition` before each iteration, exposes the carried value as
`{current}` and the zero-based round as `{iteration}`, and returns the final
carried value. The required `max` cap and the workflow iteration budget bound
execution even when the condition never becomes false.
