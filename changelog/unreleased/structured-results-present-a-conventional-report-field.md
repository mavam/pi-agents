---
title: Structured results present a conventional report field
type: feature
authors:
  - mavam
created: 2026-08-22T05:58:58.075632Z
---

Structured workflow results now follow the `report` convention: when a final
result contains a top-level `report` string, completion cards and
`/workflow <id> result` render it as human-facing Markdown, while the complete
structured value remains available to the calling model, parent workflows, and
`workflow_result`. A saved workflow's explicit `display` path still takes
precedence, and a missing or non-string path now falls back to `report` before
the raw result. Setting `display` on model-facing calls is deprecated.
