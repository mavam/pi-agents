---
title: Directed model tools for workflow runs
type: breaking
authors:
  - mavam
prs:
  - 56
created: 2026-08-11T11:33:07.614056Z
---

The model can now manage workflow runs without asking you to relay `/workflow` command output:

- `workflow_create`: Start a saved workflow or inline flow.
- `workflow_list`: List recent persisted runs from the current session.
- `workflow_inspect`: Inspect a run's status, live tree, progress, usage, errors, and exact node instances.
- `workflow_result`: Retrieve paginated run or node results, optionally selecting a smaller value by dot path.
- `workflow_steer`: Queue a course correction for a live node.
- `workflow_stop`: Stop a live run after you explicitly request cancellation.

These tools replace the model-facing `workflow` and `steer` tools. Integrations that select pi-agents tools by name must migrate:

```text
workflow → workflow_create
steer    → workflow_steer
```

Large persisted results remain recoverable through repeated `workflow_result` calls with `nextCursor`.
