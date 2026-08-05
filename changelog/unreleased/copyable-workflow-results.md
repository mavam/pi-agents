---
title: Copyable workflow results
type: feature
authors:
  - mavam
  - codex
prs:
  - 50
created: 2026-08-05T09:44:38.403894Z
---

The TUI can now copy a finished workflow's human-facing result directly:

```sh
/workflow <run-id> copy
```

For workflows with a valid `display` path, the command copies the selected
Markdown string without the surrounding completion metadata or structured
routing data. Other workflows fall back to their complete result value.
