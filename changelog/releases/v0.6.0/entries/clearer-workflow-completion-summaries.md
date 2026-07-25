---
title: Clearer workflow completion summaries
type: change
authors:
  - mavam
  - codex
prs:
  - 20
created: 2026-07-25T12:06:52.648215Z
---

Workflow completion notifications now use pi-agents' workflow and status icon language, with theme-aware colors for completed, failed, and stopped runs:

```text
❖ review · 9a7eb000 · ● completed · 3 turns ↑12k ↓4k · 4 agents
```

The compact headline keeps the workflow name, run ID, outcome, and usage together while presenting inspection commands and the result as separate, readable sections.
