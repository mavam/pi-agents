Inline workflow calls can now present a selected Markdown field from structured results while preserving the full machine-readable object for models, parent workflows, and raw access. This makes workflow output easier to read without sacrificing structured data.

## 🚀 Features

### Inline workflow result presentation

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

*By @mavam and @codex in #53.*
