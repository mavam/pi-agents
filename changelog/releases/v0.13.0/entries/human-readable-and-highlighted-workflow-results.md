---
title: Human-readable and highlighted workflow results
type: change
authors:
  - mavam
  - codex
prs:
  - 48
created: 2026-08-05T09:43:01.934335Z
---

`/workflow <id> result` now shows the workflow's declared human-facing `display` value. Use `/workflow <id> raw` to inspect the complete machine-readable value:

```console
/workflow e5eef505 result
/workflow e5eef505 raw
```

Raw and structured fallback values use JSON-tagged Markdown fences, so Pi applies its native JSON syntax highlighting. String results continue to render as Markdown.
