---
title: Icon trees for reading flows
type: feature
authors:
  - mavam
created: 2026-07-16T00:00:00.000000Z
---

Flows render as compact icon trees everywhere they are displayed: `✦` agent,
`⑃` par with `⑂` reduce, `⇶` map, `↺` loop, `⧉` workflow, with sequences
transparent and task previews inline. The tool call display shows the tree
instead of raw JSON arguments, `/workflow <name>` shows the tree above the
JSON definition, and `/run <id>` overlays live status icons (`○ ◉ ● ✗ ⊘`)
on the same skeleton, aggregating map items and loop iterations in place
(`[3/5]`). In the tool-call render the tree is colored dataflow-first:
every `{reference}` and binding in theme accent, prose and connectors dim,
kind glyphs muted — structure and data plumbing are separable at a glance.
The JSON/YAML form remains the canonical authoring syntax.
