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
structural agent position (`● scout → {files}   ◉ ⇶map {files} [2/5]   ○
⑂reduce → synthesizer`). The animation timer runs only while runs are
active and is disposed on shutdown.
