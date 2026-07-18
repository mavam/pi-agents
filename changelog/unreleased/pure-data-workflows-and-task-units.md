---
title: Pure-data workflows and reusable task units
type: feature
authors:
  - mavam
created: 2026-07-17T00:00:00.000000Z
---

Workflow files are pure data now: one YAML or JSON object per file, with
the extension deciding the parser (.yaml, .yml, .json) and prose living in
an optional doc: key. The earlier markdown/frontmatter form is gone. Single-unit workflows can skip
the graph entirely with the flat form — `agent:` plus optional `task:`,
`model:`, `thinking:` — which normalizes to a bare agent leaf while keeping
full workflow powers (params, slash command, hooks, cross-workflow
references) — the flat workflow is the one named, reusable agent+task unit,
while agent files stay purely personas (who: system prompt, model, thinking,
tools, skills). Agent nodes accept `model:`/`thinking:` overrides with the
precedence flow node → agent file → active session.
