---
title: Optional fancy footer workflow counters
type: feature
authors:
  - mavam
  - codex
prs:
  - 12
created: 2026-07-23T17:56:35.764767Z
---

`pi-agents` now offers two compact widgets for `pi-fancy-footer`: `❖N` shows
the number of active workflow executions, while `✦A/T` shows completed and
total agents across those executions. For example, `❖2 ✦4/7` means two
executions are active and four of their seven agents have completed.

Both widgets are off by default and can be enabled independently from
`/fancy-footer`. The integration uses the footer's event protocol, so
installing `pi-fancy-footer` remains optional.
