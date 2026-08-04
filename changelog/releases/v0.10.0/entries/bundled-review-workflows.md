---
title: Bundled review workflows
type: feature
authors:
  - mavam
  - codex
prs:
  - 34
created: 2026-08-04T07:08:44.770189Z
---

Installing pi-agents now makes the `review` and `review-fix` workflows available in every directory while keeping their standard YAML definitions as the package source of truth.

You can disable all bundled workflows globally:

```json
{
  "bundledWorkflows": false
}
```

Set individual workflow names in `~/.pi/agent/workflows.json` or a trusted project's `.pi/workflows.json` to override the inherited default. User and project workflow files with matching names continue to replace the bundled definitions.
