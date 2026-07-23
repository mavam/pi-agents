---
title: Optional fancy footer run summary
type: feature
authors:
  - mavam
  - codex
created: 2026-07-23T17:56:35.764767Z
---

`pi-agents` now offers a compact `pi-agents.runs` widget for
`pi-fancy-footer`. It summarizes active runs, aggregate agent progress, and
live token usage, for example `2 runs · 4/7 agents · 12.4k tok`.

The widget is off by default. Open `/fancy-footer` and move **Agent runs** off
the bench to enable it. The integration uses the footer's event protocol, so
installing `pi-fancy-footer` remains optional.
