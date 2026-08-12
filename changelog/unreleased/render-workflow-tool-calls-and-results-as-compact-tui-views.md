---
title: Render workflow tool calls and results as compact TUI views
type: change
authors:
  - mavam
created: 2026-08-12T05:15:13.326813Z
---

The `workflow_list`, `workflow_inspect`, `workflow_result`, `workflow_steer`, and `workflow_stop` tools no longer print raw JSON in the TUI. Each tool now renders a compact, themed call line and result view: run lists show one status-glyph line per run, inspect shows the run header plus its live tree, results render as Markdown with pagination metadata, and steer/stop show one-line confirmations. The model-facing JSON payloads are unchanged.
