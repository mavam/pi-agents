---
title: Compact run notification controls
type: change
authors:
  - mavam
  - claude
prs:
  - 38
created: 2026-08-04T07:20:00.000000Z
---

The control bar under a finished run's notification is now a single
glyph-prefixed usage line instead of three labelled links:

```
❖ `/workflow d1bb9fac` [result|agents]
```

The `❖` glyph comes from the shared workflow icon and marks the line as
injected UI chrome rather than agent output; in TUI cards the whole line
renders dim for the same reason. The base command stays inside the code span so
it copies cleanly, and `result` and `agents` remain the real `/workflow`
sub-commands the notation advertises.
