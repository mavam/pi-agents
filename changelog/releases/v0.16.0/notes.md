The workflow management tools now render compact, themed TUI views instead of raw JSON, making run status, live trees, paginated results, and confirmations easier to scan. The model-facing payloads remain unchanged.

## 🔧 Changes

### Render workflow tool calls and results as compact TUI views

The `workflow_list`, `workflow_inspect`, `workflow_result`, `workflow_steer`, and `workflow_stop` tools no longer print raw JSON in the TUI. Each tool now renders a compact, themed call line and result view: run lists show one status-glyph line per run, inspect shows the run header plus its live tree, results render as Markdown with pagination metadata, and steer/stop show one-line confirmations. The model-facing JSON payloads are unchanged.

*By @mavam.*
