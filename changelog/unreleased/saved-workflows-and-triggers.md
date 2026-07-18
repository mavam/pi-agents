---
title: Saved workflows with three trigger surfaces
type: feature
authors:
  - mavam
created: 2026-07-16T00:00:00.000000Z
---

Workflows can be saved as pure YAML/JSON files (`.pi/workflows/*.yaml`, the
extension decides the parser) and fire from three surfaces: the model invokes them via
the single `workflow` tool guided by `trigger` descriptions in the system
prompt; each saved workflow auto-registers a slash command that runs the
graph directly with args bound to params; and `on: [event]` frontmatter
triggers background runs from pi events, with per-workflow debounce and the
event payload bound as `{params.event}`. Terminology settles on **workflow**
(definition) and **run** (execution): `/workflows`, `/workflow <name>`,
`/runs`, and `/run <id>` with `watch`, `mermaid`, and `stop` actions replace
the old `/flows` commands. Agents gain a `tools:` allowlist forwarded to the
delegated process.
