---
title: Copyable workflow results
type: feature
authors:
  - mavam
  - codex
prs:
  - 50
created: 2026-08-05T09:47:36.387977Z
---

The TUI can now copy a finished workflow's human-facing result directly:

```sh
/workflow <run-id> copy
```

In the run browser, press `c` on a settled run to copy the same result. Running
rows continue to show `c cancel`, while settled runs without a result omit the
shortcut.

For workflows with a valid `display` path, both actions copy the selected
Markdown string without the surrounding completion metadata or structured
routing data. Other workflows fall back to their complete result value.
