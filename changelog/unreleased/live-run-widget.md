---
title: Live two-line run widget
type: feature
authors:
  - mavam
created: 2026-07-16T00:00:00.000000Z
---

The above-editor widget now shows two theme-colored lines per live run: an
animated braille spinner with the completion percentage (over known agents —
the denominator grows as map items are discovered), the label, dim run id,
elapsed time, a live token counter fed by streaming usage, and the active
agent's latest output excerpt dimmed to the end of the line (ANSI-aware
truncation at terminal width); below it, one status-iconed segment per
top-level step, with composite phases collapsed to their kind glyph and
aggregate agent counts (`● explorer → {map}   ◉ ⑃ par [2/4]   ○ ⇶ map   ○ ↺
loop`). The full vertical structure lives in the tool-call render — the
workflow tool shows the icon tree of the flow and a single status line
(`◉ running in background · /run <id>`) with no duplicated label or id —
while the widget stays a horizontal live pulse. The animation timer runs
only while runs are active and is disposed on shutdown.
