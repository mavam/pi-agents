---
title: Human-readable structured workflow results
type: feature
authors:
  - mavam
  - codex
prs:
  - 25
created: 2026-08-03T08:04:32.726554Z
---

Structured workflows can now present a human-readable Markdown result without
giving up their machine-readable value. Set `display` to the dot path of the
Markdown field:

```yaml
name: review
display: report
```

Completion cards and run details render the complete selected string, while
parent workflows and `/workflow <id> result` retain the original structured
value. A missing or non-string display path falls back to the raw result.
