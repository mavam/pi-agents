---
title: Directed model tools for workflow runs
type: breaking
authors:
  - mavam
prs:
  - 56
created: 2026-08-11T11:33:07.614056Z
---

The model can now inspect and control persisted workflow runs without asking you to relay `/workflow` command output. It can list recent runs, inspect a live run tree, retrieve paginated run or node results, steer an agent, and stop a run when you explicitly request cancellation.

The model-facing `workflow` and `steer` tools have been replaced by directed tools. Integrations that select pi-agents tools by name must migrate:

```text
workflow → workflow_create
steer    → workflow_steer
```

The complete model-facing set is `workflow_create`, `workflow_list`, `workflow_inspect`, `workflow_result`, `workflow_steer`, and `workflow_stop`. Large persisted results remain recoverable through repeated `workflow_result` calls with `nextCursor` or by selecting a smaller dot path.
