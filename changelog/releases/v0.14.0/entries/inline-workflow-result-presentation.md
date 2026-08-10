---
title: Inline workflow result presentation
type: feature
authors:
  - mavam
  - codex
prs:
  - 53
created: 2026-08-09T18:11:25.087273Z
---

Inline workflow calls can now select a Markdown field from a structured final value without discarding the complete machine-readable result:

```json
{
  "flow": {
    "kind": "agent",
    "task": "Review the current change",
    "json": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" },
        "findings": { "type": "array" }
      }
    }
  },
  "display": "summary"
}
```

Completion cards, `/workflow <id> result`, and `/workflow <id> copy` render the selected field as Markdown. The calling model, parent workflows, and `/workflow <id> raw` retain the complete object. A call-level `display` can also override a saved workflow's declared path, and unresolved paths now produce a visible fallback warning.
