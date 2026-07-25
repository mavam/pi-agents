---
title: Zero-agent workflow budgets
type: change
authors:
  - mavam
  - codex
prs:
  - 19
created: 2026-07-25T11:44:45.605215Z
---

Pure-data workflows can now set `maxAgents: 0` to guarantee that a run does not execute agents or reducers:

```json
{
  "flow": { "kind": "value", "value": "done" },
  "budgets": { "maxAgents": 0 }
}
```

Value and structural nodes continue to run normally. If an executed branch reaches an agent, the run fails before starting its subprocess. The workflow tool also exposes each budget's valid range, unit, and default to prevent invalid model-generated arguments.
